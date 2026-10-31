import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { Stats } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobName, JobStatus } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AssetJobRepository } from 'src/repositories/asset-job.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { ConfigRepository } from 'src/repositories/config.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { MetadataRepository } from 'src/repositories/metadata.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository';
import { TagRepository } from 'src/repositories/tag.repository';
import { DB } from 'src/schema';
import { MetadataService } from 'src/services/metadata.service';
import { TagService } from 'src/services/tag.service';
import { upsertTags } from 'src/utils/tag';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB, newRandomImage } from 'test/utils';

type TimeZoneTest = {
  description: string;
  serverTimeZone?: string;
  exifData: Record<string, any>;
  expected: {
    localDateTime: string;
    dateTimeOriginal: string;
    timeZone: string | null;
  };
};

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(MetadataService, {
    database: db || defaultDatabase,
    real: [
      AssetRepository,
      AssetJobRepository,
      ConfigRepository,
      MetadataRepository,
      SystemMetadataRepository,
      TagRepository,
    ],
    mock: [EventRepository, JobRepository, StorageRepository, LoggingRepository],
  });

  ctx.getMock(StorageRepository).stat.mockResolvedValue({
    size: 123_456,
    mtime: new Date(654_321),
    mtimeMs: 654_321,
    birthtimeMs: 654_322,
  } as Stats);

  return { sut, ctx };
};

const createTestFile = async (exifData: Record<string, any>) => {
  const { ctx } = setup();
  const data = newRandomImage();
  const filePath = join(tmpdir(), 'test.png');
  await writeFile(filePath, data);
  await ctx.get(MetadataRepository).writeTags(filePath, exifData);
  return { filePath };
};

/** A metadata service and a tag service on the same database, with assets that have real files */
const setupTagging = async () => {
  const { sut, ctx } = setup();
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  const { sut: tagService, ctx: tagCtx } = newMediumService(TagService, {
    database: ctx.database,
    real: [AccessRepository, AssetRepository, TagRepository],
    mock: [EventRepository, LoggingRepository],
  });
  tagCtx.getMock(EventRepository).emit.mockResolvedValue();
  ctx.getMock(JobRepository).queue.mockResolvedValue();

  const { user } = await ctx.newUser();
  const auth = factory.auth({ user });
  const [tagA, tagB] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['tag-a', 'tag-b'] });

  const newTaggableAsset = async () => {
    const originalPath = join(tmpdir(), `${randomUUID()}.png`);
    await writeFile(originalPath, newRandomImage());
    const { asset } = await ctx.newAsset({ originalPath, ownerId: user.id });
    await ctx.newExif({ assetId: asset.id, description: '' });
    return asset;
  };

  const getTags = async (assetId: string) => {
    const rows = await ctx.database
      .selectFrom('tag_asset')
      .innerJoin('tag', 'tag.id', 'tag_asset.tagId')
      .select('tag.value')
      .where('tag_asset.assetId', '=', assetId)
      .orderBy('tag.value')
      .execute();
    const exif = await ctx.database
      .selectFrom('asset_exif')
      .select('tags')
      .where('assetId', '=', assetId)
      .executeTakeFirstOrThrow();
    return { tagAsset: rows.map(({ value }) => value), exif: [...(exif.tags ?? [])].sort() };
  };

  const getSidecarTags = async (assetId: string) => {
    const asset = await ctx.get(AssetRepository).getById(assetId);
    const tags = await ctx.get(MetadataRepository).readTags(`${asset!.originalPath}.xmp`);
    const list = tags.TagsList ?? [];
    return (Array.isArray(list) ? list : [list]).map(String).sort();
  };

  return { sut, ctx, tagService, tagCtx, auth, tagA, tagB, newTaggableAsset, getTags, getSidecarTags };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(MetadataService.name, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should be defined', () => {
    const { sut } = setup();
    expect(sut).toBeDefined();
  });

  describe('handleMetadataExtraction', () => {
    const timeZoneTests: TimeZoneTest[] = [
      {
        description: 'should handle no time zone information',
        exifData: {
          DateTimeOriginal: '2022:01:01 00:00:00',
        },
        expected: {
          localDateTime: '2022-01-01T00:00:00.000Z',
          dateTimeOriginal: '2022-01-01T00:00:00.000Z',
          timeZone: null,
        },
      },
      {
        description: 'should handle a +13:00 time zone',
        exifData: {
          DateTimeOriginal: '2022:01:01 00:00:00+13:00',
        },
        expected: {
          localDateTime: '2022-01-01T00:00:00.000Z',
          dateTimeOriginal: '2021-12-31T11:00:00.000Z',
          timeZone: 'UTC+13',
        },
      },
    ];

    it.each(timeZoneTests)('$description', async ({ exifData, serverTimeZone, expected }) => {
      vi.stubEnv('TZ', serverTimeZone);

      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile(exifData);
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });

      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select(['dateTimeOriginal', 'timeZone', 'lockedProperties'])
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        dateTimeOriginal: new Date(expected.dateTimeOriginal),
        timeZone: expected.timeZone,
        lockedProperties: null,
      });

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toEqual(
        expect.objectContaining({ localDateTime: new Date(expected.localDateTime) }),
      );
    });

    it('should handle dates far in the future', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile({ CreateDate: '42603:05:04 04:12:48' });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });

      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .where('assetId', '=', asset.id)
          .select('dateTimeOriginal')
          .executeTakeFirstOrThrow(),
        // note that this date is technically wrong. it does not throw though and should get the user's attention either way.
      ).resolves.toEqual({ dateTimeOriginal: new Date('4260-03-05T04:04:12.000Z') });
    });

    it('should ignore IFD1 thumbnail orientation when extracting metadata', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile({ 'IFD1:Orientation#': 6 });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });

      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('orientation')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ orientation: null });
    });

    it('should ignore IFD1 thumbnail dimensions when extracting metadata', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile({ 'IFD1:ImageWidth#': 160, 'IFD1:ImageHeight#': 120 });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });

      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toEqual(
        expect.objectContaining({ width: 1, height: 1 }),
      );
    });

    it('should keep IFD0 orientation when extracting metadata', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile({ 'IFD0:Orientation#': 6 });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });

      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('orientation')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ orientation: '6' });
    });
  });

  it('should handle float lens models (#30492)', async () => {
    const { sut, ctx } = setup();
    ctx.getMock(EventRepository).emit.mockResolvedValue();
    const { filePath } = await createTestFile({ LensModel: 1.8 });
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
    await ctx.newExif({ assetId: asset.id, description: '' });

    await sut.handleMetadataExtraction({ id: asset.id });

    await expect(
      ctx.database
        .selectFrom('asset_exif')
        .where('assetId', '=', asset.id)
        .select('lensModel')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ lensModel: '1.8' });
  });

  describe('tag changes while the sidecar is written', () => {
    it('should keep a tag that is added while the sidecar is written', async () => {
      const { sut, ctx, tagService, auth, tagA, tagB, newTaggableAsset, getTags, getSidecarTags } =
        await setupTagging();
      const asset = await newTaggableAsset();
      await tagService.addAssets(auth, tagA.id, { ids: [asset.id] });

      const metadataRepository = ctx.get(MetadataRepository);
      const writeTags = metadataRepository.writeTags.bind(metadataRepository);
      const spy = vi.spyOn(metadataRepository, 'writeTags').mockImplementationOnce(async (path, tags) => {
        await tagService.addAssets(auth, tagB.id, { ids: [asset.id] });
        return writeTags(path, tags);
      });

      await sut.handleSidecarWrite({ id: asset.id });
      spy.mockRestore();
      await sut.handleMetadataExtraction({ id: asset.id });
      await sut.handleSidecarWrite({ id: asset.id });
      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(getTags(asset.id)).resolves.toEqual({ tagAsset: ['tag-a', 'tag-b'], exif: ['tag-a', 'tag-b'] });
      await expect(getSidecarTags(asset.id)).resolves.toEqual(['tag-a', 'tag-b']);
    });

    it('should not bring back a tag that is removed while the sidecar is written', async () => {
      const { sut, ctx, tagService, auth, tagA, tagB, newTaggableAsset, getTags, getSidecarTags } =
        await setupTagging();
      const asset = await newTaggableAsset();
      await tagService.addAssets(auth, tagA.id, { ids: [asset.id] });
      await tagService.addAssets(auth, tagB.id, { ids: [asset.id] });

      const metadataRepository = ctx.get(MetadataRepository);
      const writeTags = metadataRepository.writeTags.bind(metadataRepository);
      const spy = vi.spyOn(metadataRepository, 'writeTags').mockImplementationOnce(async (path, tags) => {
        await tagService.removeAssets(auth, tagB.id, { ids: [asset.id] });
        return writeTags(path, tags);
      });

      await sut.handleSidecarWrite({ id: asset.id });
      spy.mockRestore();
      await sut.handleMetadataExtraction({ id: asset.id });
      await sut.handleSidecarWrite({ id: asset.id });
      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(getTags(asset.id)).resolves.toEqual({ tagAsset: ['tag-a'], exif: ['tag-a'] });
      await expect(getSidecarTags(asset.id)).resolves.toEqual(['tag-a']);
    });

    it('should keep a tag that is added while metadata is extracted from an older sidecar', async () => {
      const { sut, ctx, tagService, auth, tagA, tagB, newTaggableAsset, getTags, getSidecarTags } =
        await setupTagging();
      const asset = await newTaggableAsset();
      await tagService.addAssets(auth, tagA.id, { ids: [asset.id] });
      await sut.handleSidecarWrite({ id: asset.id });

      const metadataRepository = ctx.get(MetadataRepository);
      const readTags = metadataRepository.readTags.bind(metadataRepository);
      const spy = vi.spyOn(metadataRepository, 'readTags').mockImplementation(async (path) => {
        const tags = await readTags(path);
        if (path.endsWith('.xmp')) {
          // the file was read before the new tag was written to it
          spy.mockRestore();
          await tagService.addAssets(auth, tagB.id, { ids: [asset.id] });
          await sut.handleSidecarWrite({ id: asset.id });
        }
        return tags;
      });

      await sut.handleMetadataExtraction({ id: asset.id });
      spy.mockRestore();

      await expect(getTags(asset.id)).resolves.toEqual({ tagAsset: ['tag-a', 'tag-b'], exif: ['tag-a', 'tag-b'] });
      await expect(getSidecarTags(asset.id)).resolves.toEqual(['tag-a', 'tag-b']);
    });

    it('should keep a tag when the sidecar cannot be written', async () => {
      const { sut, ctx, tagService, auth, tagA, tagB, newTaggableAsset, getTags } = await setupTagging();
      const asset = await newTaggableAsset();
      await tagService.addAssets(auth, tagA.id, { ids: [asset.id] });
      await sut.handleSidecarWrite({ id: asset.id });
      await tagService.addAssets(auth, tagB.id, { ids: [asset.id] });

      // for example a read-only library, or another job writing the same file at the same moment
      const spy = vi.spyOn(ctx.get(MetadataRepository), 'writeTags').mockResolvedValueOnce(false);
      await expect(sut.handleSidecarWrite({ id: asset.id })).resolves.toBe(JobStatus.Failed);
      spy.mockRestore();
      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(getTags(asset.id)).resolves.toEqual({ tagAsset: ['tag-a', 'tag-b'], exif: ['tag-a', 'tag-b'] });
    });

    it('should keep a tag when an older sidecar write finishes after a newer one', async () => {
      const { sut, ctx, tagService, auth, tagA, tagB, newTaggableAsset, getTags, getSidecarTags } =
        await setupTagging();
      const asset = await newTaggableAsset();
      await tagService.addAssets(auth, tagA.id, { ids: [asset.id] });

      const metadataRepository = ctx.get(MetadataRepository);
      const writeTags = metadataRepository.writeTags.bind(metadataRepository);
      const spy = vi.spyOn(metadataRepository, 'writeTags').mockImplementationOnce(async (path, tags) => {
        // a second job for the same asset starts and finishes while the first one is still writing
        await tagService.addAssets(auth, tagB.id, { ids: [asset.id] });
        await sut.handleSidecarWrite({ id: asset.id });
        return writeTags(path, tags);
      });

      await sut.handleSidecarWrite({ id: asset.id });
      spy.mockRestore();
      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(getTags(asset.id)).resolves.toEqual({ tagAsset: ['tag-a', 'tag-b'], exif: ['tag-a', 'tag-b'] });

      // the stale file is written again
      expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
        name: JobName.SidecarWrite,
        data: { id: asset.id },
      });
      await sut.handleSidecarWrite({ id: asset.id });
      await sut.handleMetadataExtraction({ id: asset.id });
      await expect(getTags(asset.id)).resolves.toEqual({ tagAsset: ['tag-a', 'tag-b'], exif: ['tag-a', 'tag-b'] });
      await expect(getSidecarTags(asset.id)).resolves.toEqual(['tag-a', 'tag-b']);
    });

    it('should keep a tag that is bulk added while metadata is extracted', async () => {
      const { sut, tagService, tagCtx, auth, tagA, tagB, newTaggableAsset, getTags } = await setupTagging();
      const assets = [await newTaggableAsset(), await newTaggableAsset(), await newTaggableAsset()];
      const assetIds = assets.map(({ id }) => id);

      await tagService.bulkTagAssets(auth, { tagIds: [tagA.id], assetIds });
      for (const id of assetIds) {
        await sut.handleSidecarWrite({ id });
      }

      const tagRepository = tagCtx.get(TagRepository);
      const upsertAssetIds = tagRepository.upsertAssetIds.bind(tagRepository);
      const spy = vi.spyOn(tagRepository, 'upsertAssetIds').mockImplementationOnce(async (items) => {
        const results = await upsertAssetIds(items);
        // metadata extraction finishes right after the new tag is stored
        for (const id of assetIds) {
          await sut.handleMetadataExtraction({ id });
        }
        return results;
      });

      await tagService.bulkTagAssets(auth, { tagIds: [tagB.id], assetIds });
      spy.mockRestore();

      for (const id of assetIds) {
        await expect(getTags(id)).resolves.toEqual({ tagAsset: ['tag-a', 'tag-b'], exif: ['tag-a', 'tag-b'] });
      }
    });
  });
});
