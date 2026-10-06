import sharp from 'sharp';
import { AssetEditAction } from 'src/dtos/editing.dto';
import {
  AlbumUserRole,
  AssetMetadataKey,
  AssetStatus,
  AssetType,
  DeletedReimportMode,
  JobName,
  TakeoutRunFileAction,
  TakeoutRunFileStatus,
  UserMetadataKey,
} from 'src/enum';
import { TakeoutRunService } from 'src/services/takeout-run.service';
import { computeImageSample, detectRotationFromSamples } from 'src/takeout/image-sample';
import { authStub } from 'test/fixtures/auth.stub';
import { newTestService, ServiceMocks } from 'test/utils';
import { beforeEach, describe, expect, it } from 'vitest';

const userId = authStub.admin.user.id;

const run = () => ({
  id: 'run-1',
  userId,
  templateVars: { date: '2020-06-15', user: 'me', start: '2020-06-15' },
});

const settings = () => ({
  homeTimeZone: 'America/New_York',
  syncAlbums: false,
  googlePhotosFields: false,
  applyRotation: false,
  tagServerDuplicates: false,
  sessionTag: false,
  sessionTagTemplate: '',
  takeoutTag: false,
  customTags: [],
});

// a rotate-only-pair original of the shared asset 'asset-orig' (section 11 D1) and its dropped copy
const sharedOriginal = (id: string, seq: number, copySeq: number) => ({
  id,
  seq,
  assetId: 'asset-orig',
  status: TakeoutRunFileStatus.Done,
  action: seq === 0 ? TakeoutRunFileAction.Upload : TakeoutRunFileAction.AlreadyProcessed,
  rotation: 90,
  plan: { rotateOriginal: true, rotateAngle: 90, rotateCopySeqs: [copySeq], tags: [] },
});

const droppedCopy = (id: string, seq: number, of: number) => ({
  id,
  seq,
  status: TakeoutRunFileStatus.Skipped,
  plan: { rotateCopyOf: of, tags: [] },
});

const uploadRow = (over: Record<string, unknown> = {}) => ({
  id: 'rf-1',
  seq: 0,
  takeoutPath: 'Takeout/Google Photos/photo.jpg',
  originalFileName: 'photo.jpg',
  newAssetId: 'asset-uuid',
  targetPath: '/tmp/does-not-exist/asset-uuid.jpg',
  size: 1234,
  mtime: new Date('2020-06-15T12:00:00Z'),
  checksum: Buffer.from('abcd'),
  captureDate: new Date('2020-06-15T12:00:00Z'),
  rotation: 0,
  fallbacks: [],
  plan: { latitude: 0, longitude: 0, tags: [] },
  ...over,
});

const preferences = (mode: DeletedReimportMode, albumId?: string) => [
  { key: UserMetadataKey.Preferences, value: { deletedReimport: { mode, albumId } } },
];

// another copy of the same file in the export (alreadyProcessed): it follows the copy that was imported or not
const copyOf = (seq: number) => ({
  id: 'rf-copy',
  seq: seq + 1,
  action: TakeoutRunFileAction.AlreadyProcessed as string,
  status: TakeoutRunFileStatus.Planned as string,
  dependsOnSeq: seq,
  assetId: null,
  fallbacks: [] as string[],
  plan: {},
});

describe(TakeoutRunService.name, () => {
  let sut: TakeoutRunService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TakeoutRunService));
    mocks.asset.getByIds.mockResolvedValue([]);
    mocks.asset.create.mockResolvedValue({
      id: 'asset-uuid',
      originalPath: '/tmp/does-not-exist/asset-uuid.jpg',
    } as any);
    mocks.metadata.writeTags.mockResolvedValue(true as any);
  });

  // Every upsertExif call whose payload actually carries a capture date (the PUT path), ignoring the fileSize upsert.
  const dateUpserts = () =>
    mocks.asset.upsertExif.mock.calls.filter((call) => (call[0] as any)?.exif?.dateTimeOriginal !== undefined);

  // the update that records the created asset on its row
  const createdUpdate = () =>
    mocks.takeout.updateRunFile.mock.calls.find((c) => (c[1] as any).status === TakeoutRunFileStatus.Created);

  const sidecarWriteQueued = () =>
    mocks.job.queue.mock.calls.some((call) => (call[0] as any)?.name === JobName.SidecarWrite);

  const extractionQueuedAfterSidecar = () => {
    const extractCall = mocks.job.queue.mock.calls.findIndex(
      (call) => (call[0] as any)?.name === JobName.AssetExtractMetadata,
    );
    expect(extractCall).toBeGreaterThanOrEqual(0);
    const extractOrder = mocks.job.queue.mock.invocationCallOrder[extractCall];
    for (const order of mocks.metadata.writeTags.mock.invocationCallOrder) {
      expect(order).toBeLessThan(extractOrder);
    }
    for (const order of mocks.asset.upsertExif.mock.invocationCallOrder) {
      expect(order).toBeLessThan(extractOrder);
    }
    for (const order of mocks.asset.unlockProperties.mock.invocationCallOrder) {
      expect(order).toBeLessThan(extractOrder);
    }
  };

  describe('processUpload capture date: PUT dateTimeOriginal vs sidecar (section 12)', () => {
    it('a phone whose zone is derived from Google (rule 3) stores dateTimeOriginal with an explicit offset before extraction', async () => {
      // Google/Pixel phone, wall clock 07:00 vs Google 12:00Z => whole -5h offset, no file offset, no GPS.
      mocks.metadata.readTags.mockResolvedValue({
        Make: 'Google',
        Model: 'Pixel 5',
        DateTimeOriginal: '2020:06:15 07:00:00',
      } as any);

      await (sut as any).processUpload(run(), settings(), uploadRow());

      const puts = dateUpserts();
      expect(puts).toHaveLength(1);
      const exif = (puts[0][0] as any).exif;
      // explicit offset, and the date + zone are locked until the sidecar holds them
      expect(exif.dateTimeOriginal).toMatch(/-05:00$/);
      expect(exif.timeZone).toBe('UTC-5');
      expect(exif.lockedProperties).toEqual(expect.arrayContaining(['dateTimeOriginal', 'timeZone']));
      expect((puts[0][0] as any).lockedPropertiesBehavior).toBe('append');
      // the sidecar gets exactly what SidecarWrite would write, then the locks are released, no SidecarWrite job
      expect(mocks.metadata.writeTags).toHaveBeenCalledTimes(1);
      expect((mocks.metadata.writeTags.mock.calls[0][1] as any).DateTimeOriginal).toBe('2020-06-15T07:00:00.000-05:00');
      expect(mocks.asset.unlockProperties).toHaveBeenCalledWith('asset-uuid', ['dateTimeOriginal', 'timeZone']);
      expect(sidecarWriteQueued()).toBe(false);
      extractionQueuedAfterSidecar();
    });

    it('a phone that carries its own offset (rule 1) does NOT store a date and writes nothing to the sidecar', async () => {
      mocks.metadata.readTags.mockResolvedValue({
        Make: 'Apple',
        Model: 'iPhone 12',
        DateTimeOriginal: '2020:06:15 07:00:00',
        zone: 'UTC-5',
        zoneSource: 'offset',
        GPSLatitude: 40,
        GPSLongitude: -73,
      } as any);

      await (sut as any).processUpload(run(), settings(), uploadRow());

      expect(dateUpserts()).toHaveLength(0);
      expect(sidecarWriteQueued()).toBe(false);
      expect(mocks.metadata.writeTags).not.toHaveBeenCalled();
    });

    it('tags a new asset through the sidecar TagsList before extraction, without the AssetTag event', async () => {
      mocks.metadata.readTags.mockResolvedValue({
        Make: 'Apple',
        Model: 'iPhone 12',
        DateTimeOriginal: '2020:06:15 07:00:00',
        zone: 'UTC-5',
        zoneSource: 'offset',
      } as any);
      mocks.tag.upsertValue.mockImplementation(
        ({ value }: any) => Promise.resolve({ id: `tag-${value}`, value }) as any,
      );
      mocks.tag.upsertAssetIds.mockResolvedValue([] as any);

      await (sut as any).processUpload(
        run(),
        settings(),
        uploadRow({ plan: { latitude: 0, longitude: 0, tags: ['People/Ana Lozano ', 'takeout-x'] } }),
      );

      const tags = mocks.metadata.writeTags.mock.calls[0][1] as any;
      // the trailing space of a Google person name is kept, as Go sends it
      expect(tags.TagsList).toEqual(['People/Ana Lozano ', 'takeout-x']);
      expect(tags.DateTimeOriginal).toBeUndefined();
      expect(mocks.asset.unlockProperties).toHaveBeenCalledWith('asset-uuid', ['tags']);
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AssetTag', expect.anything());
      extractionQueuedAfterSidecar();
    });

    it('writes Google GPS to the sidecar when the file lacks GPS', async () => {
      mocks.metadata.readTags.mockResolvedValue({
        Make: 'Google',
        Model: 'Pixel 5',
        DateTimeOriginal: '2020:06:15 07:00:00',
      } as any);

      await (sut as any).processUpload(
        run(),
        settings(),
        uploadRow({ plan: { latitude: 40.1, longitude: -73.2, tags: [] } }),
      );

      expect(mocks.metadata.writeTags).toHaveBeenCalledTimes(1);
      const tags = mocks.metadata.writeTags.mock.calls[0][1] as any;
      expect(tags.GPSLatitude).toBe(40.1);
      expect(tags.GPSLongitude).toBe(-73.2);
      expect(dateUpserts()).toHaveLength(1);
      extractionQueuedAfterSidecar();
    });

    it('does not write Google GPS to the sidecar when the file already has GPS', async () => {
      mocks.metadata.readTags.mockResolvedValue({
        Make: 'Google',
        Model: 'Pixel 5',
        DateTimeOriginal: '2020:06:15 07:00:00',
        GPSLatitude: 1,
        GPSLongitude: 2,
      } as any);

      await (sut as any).processUpload(
        run(),
        settings(),
        uploadRow({ plan: { latitude: 40.1, longitude: -73.2, tags: [] } }),
      );

      const tags = mocks.metadata.writeTags.mock.calls[0]?.[1] as any;
      expect(tags?.GPSLatitude).toBeUndefined();
      expect(tags?.GPSLongitude).toBeUndefined();
    });
  });

  describe('processUpload result counters', () => {
    it('records album, tag and metadata flags on the row for the run counters', async () => {
      mocks.metadata.readTags.mockResolvedValue({ Make: 'Apple', zone: 'UTC-5', zoneSource: 'offset' } as any);
      mocks.album.getAll.mockResolvedValue([]);
      mocks.album.create.mockResolvedValue({ id: 'album-1' } as any);
      mocks.album.addAssetIds.mockResolvedValue(undefined as any);
      mocks.tag.upsertValue.mockImplementation(
        ({ value }: any) => Promise.resolve({ id: `tag-${value}`, value }) as any,
      );
      mocks.tag.upsertAssetIds.mockResolvedValue([] as any);
      mocks.asset.upsertMetadata.mockResolvedValue(undefined as any);
      const row = uploadRow({
        plan: { latitude: 0, longitude: 0, tags: ['takeout-x'], albums: [{ title: 'Trip' }], extra: { views: 1 } },
      });

      await (sut as any).processUpload(run(), { ...settings(), syncAlbums: true, googlePhotosFields: true }, row);

      const last = mocks.takeout.updateRunFile.mock.calls.findLast((c) => c[0] === 'rf-1' && (c[1] as any).fallbacks);
      expect((last![1] as any).fallbacks).toEqual(
        expect.arrayContaining(['tagged', 'albumCreated:Trip', 'albumAdded', 'metadataSaved']),
      );
    });
  });

  describe('google-photos metadata', () => {
    const extra = { url: 'https://photos.google.com/photo/AF1Qip', views: 1 };

    beforeEach(() => {
      mocks.metadata.readTags.mockResolvedValue({ Make: 'Apple', zone: 'UTC-5', zoneSource: 'offset' } as any);
      mocks.asset.upsertMetadata.mockResolvedValue(undefined as any);
    });

    it('saves the Google account of the export with the url', async () => {
      const withEmail = { ...run(), templateVars: { ...run().templateVars, email: 'someone@example.com' } };

      await (sut as any).processUpload(
        withEmail,
        { ...settings(), googlePhotosFields: true },
        uploadRow({ plan: { tags: [], extra } }),
      );

      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith('asset-uuid', [
        { key: 'google-photos', value: { ...extra, account: 'someone@example.com' } },
      ]);
    });

    it('saves no account for a run without an email', async () => {
      await (sut as any).processUpload(
        run(),
        { ...settings(), googlePhotosFields: true },
        uploadRow({ plan: { tags: [], extra } }),
      );

      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith('asset-uuid', [{ key: 'google-photos', value: extra }]);
    });
  });

  describe('a previously deleted file is handled like an upload of it (utils/deleted-reimport)', () => {
    const remembered = { assetId: 'deleted-asset', originalFileName: 'photo.jpg', deletedAt: new Date() };

    beforeEach(() => {
      mocks.metadata.readTags.mockResolvedValue({} as any);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-uuid',
        checksum: Buffer.from('abcd'),
        originalPath: '/tmp/does-not-exist/asset-uuid.jpg',
      } as any);
      mocks.assetDeletedChecksum.get.mockResolvedValue(remembered);
    });

    it('does not import it in skip mode: a previouslyDeletedSkipped report row, the owner is told', async () => {
      mocks.user.getMetadata.mockResolvedValue(preferences(DeletedReimportMode.Skip));
      const row = uploadRow();

      await (sut as any).processUpload(run(), settings(), row);

      expect(mocks.assetDeletedChecksum.get).toHaveBeenCalledWith(userId, row.checksum);
      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.takeout.updateRunFile).toHaveBeenCalledExactlyOnceWith('rf-1', {
        action: TakeoutRunFileAction.PreviouslyDeletedSkipped,
        status: TakeoutRunFileStatus.Skipped,
        reason: 'previously deleted (skipped)',
        targetPath: null,
      });
      expect(row).toMatchObject({
        action: TakeoutRunFileAction.PreviouslyDeletedSkipped,
        status: TakeoutRunFileStatus.Skipped,
        targetPath: null,
      });
      expect(mocks.assetDeletedChecksum.markReimported).toHaveBeenCalledExactlyOnceWith(
        userId,
        row.checksum,
        DeletedReimportMode.Skip,
      );
      expect(mocks.event.emit).toHaveBeenCalledExactlyOnceWith('AssetDeletedReimport', { userId });
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(mocks.album.addAssetIds).not.toHaveBeenCalled();
    });

    it('imports it and moves it to the trash right away in trash mode', async () => {
      mocks.user.getMetadata.mockResolvedValue(preferences(DeletedReimportMode.Trash));

      await (sut as any).processUpload(run(), settings(), uploadRow());

      expect(mocks.asset.create).toHaveBeenCalledTimes(1);
      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith('asset-uuid', [
        {
          key: AssetMetadataKey.DeletedReimport,
          value: { mode: DeletedReimportMode.Trash, reimportedAt: expect.any(String) },
        },
      ]);
      expect(mocks.asset.updateAll).toHaveBeenCalledExactlyOnceWith(['asset-uuid'], {
        deletedAt: expect.any(Date),
        status: AssetStatus.Trashed,
      });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetTrashAll', { assetIds: ['asset-uuid'], userId });
      expect(mocks.assetDeletedChecksum.markReimported).toHaveBeenCalledExactlyOnceWith(
        userId,
        Buffer.from('abcd'),
        DeletedReimportMode.Trash,
      );
      const reimports = mocks.event.emit.mock.calls.filter(([name]) => name === 'AssetDeletedReimport');
      expect(reimports).toEqual([['AssetDeletedReimport', { userId }]]);
      expect(mocks.album.addAssetIds).not.toHaveBeenCalled();
      // recorded with the created state, so the report shows it and a resume does not handle it again
      expect((createdUpdate()![1] as any).fallbacks).toContain('previouslyDeleted:trash');
    });

    it('imports it and adds it to the "Previously deleted" album in album mode', async () => {
      const album = { id: 'album-prev', albumUsers: [{ user: { id: userId }, role: AlbumUserRole.Owner }] };
      mocks.user.getMetadata.mockResolvedValue(preferences(DeletedReimportMode.Album, album.id));
      mocks.album.getById.mockResolvedValue(album as any);

      await (sut as any).processUpload(run(), settings(), uploadRow());

      expect(mocks.asset.create).toHaveBeenCalledTimes(1);
      expect(mocks.album.getById).toHaveBeenCalledWith(album.id, { withAssets: false });
      expect(mocks.album.create).not.toHaveBeenCalled();
      expect(mocks.album.addAssetIds).toHaveBeenCalledExactlyOnceWith(album.id, ['asset-uuid']);
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumUpdate', {
        id: album.id,
        userIds: [userId],
        recipientIds: [],
      });
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(mocks.assetDeletedChecksum.markReimported).toHaveBeenCalledExactlyOnceWith(
        userId,
        Buffer.from('abcd'),
        DeletedReimportMode.Album,
      );
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetDeletedReimport', { userId });
      expect((createdUpdate()![1] as any).fallbacks).toContain('previouslyDeleted:album');
    });

    it('creates the "Previously deleted" album when the user has none', async () => {
      mocks.user.getMetadata.mockResolvedValue(preferences(DeletedReimportMode.Album));
      mocks.album.create.mockResolvedValue({ id: 'album-new' } as any);

      await (sut as any).processUpload(run(), settings(), uploadRow());

      expect(mocks.album.create).toHaveBeenCalledWith(
        expect.objectContaining({ albumName: 'Previously deleted' }),
        [],
        [{ userId, role: AlbumUserRole.Owner }],
        userId,
      );
      expect(mocks.album.addAssetIds).toHaveBeenCalledWith('album-new', ['asset-uuid']);
    });

    it('imports a file that was never deleted like any other', async () => {
      mocks.assetDeletedChecksum.get.mockResolvedValue(undefined);

      await (sut as any).processUpload(run(), settings(), uploadRow());

      expect(mocks.asset.create).toHaveBeenCalledTimes(1);
      expect(mocks.user.getMetadata).not.toHaveBeenCalled();
      expect(mocks.assetDeletedChecksum.markReimported).not.toHaveBeenCalled();
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect((createdUpdate()![1] as any).fallbacks).not.toContain('previouslyDeleted:trash');
    });

    it('leaves a file that turned out to be on the server alone', async () => {
      mocks.user.getMetadata.mockResolvedValue(preferences(DeletedReimportMode.Trash));
      mocks.asset.create.mockRejectedValue(new Error('duplicate checksum'));
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue('server-asset');
      const row = uploadRow();

      await (sut as any).processUpload(run(), settings(), row);

      expect(row).toMatchObject({ action: TakeoutRunFileAction.ServerDuplicate, assetId: 'server-asset' });
      expect(mocks.asset.upsertMetadata).not.toHaveBeenCalled();
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(mocks.assetDeletedChecksum.markReimported).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AssetDeletedReimport', expect.anything());
    });

    it('does not ask again for an asset a resume adopts', async () => {
      mocks.asset.getByIds.mockResolvedValue([
        { id: 'asset-uuid', originalPath: '/tmp/does-not-exist/asset-uuid.jpg' },
      ] as any);

      await (sut as any).processUpload(run(), settings(), uploadRow({ fallbacks: ['previouslyDeleted:trash'] }));

      expect(mocks.assetDeletedChecksum.get).not.toHaveBeenCalled();
      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect((createdUpdate()![1] as any).fallbacks).toContain('previouslyDeleted:trash');
    });

    it('skips another copy of a file that was not imported', async () => {
      const source = { id: 'rf-src', seq: 0, action: TakeoutRunFileAction.PreviouslyDeletedSkipped, assetId: null };
      const copy = copyOf(0);

      await (sut as any).processExisting(run(), settings(), copy, [source, copy]);

      expect(copy).toMatchObject({
        action: TakeoutRunFileAction.PreviouslyDeletedSkipped,
        status: TakeoutRunFileStatus.Skipped,
      });
      expect(mocks.takeout.updateRunFile).toHaveBeenCalledExactlyOnceWith('rf-copy', {
        action: TakeoutRunFileAction.PreviouslyDeletedSkipped,
        status: TakeoutRunFileStatus.Skipped,
        reason: 'previously deleted (skipped)',
        targetPath: null,
      });
      // the file was reported to the owner once, by the copy that was not imported
      expect(mocks.assetDeletedChecksum.markReimported).not.toHaveBeenCalled();
    });

    it('flags another copy of a file that was imported and trashed', async () => {
      const source = {
        id: 'rf-src',
        seq: 0,
        action: TakeoutRunFileAction.Upload,
        assetId: 'asset-uuid',
        fallbacks: ['previouslyDeleted:trash'],
      };
      const copy = copyOf(0);
      mocks.asset.getByIds.mockResolvedValue([{ id: 'asset-uuid' }] as any);

      await (sut as any).processExisting(run(), settings(), copy, [source, copy]);

      expect(copy.status).toBe(TakeoutRunFileStatus.Done);
      expect(copy.assetId).toBe('asset-uuid');
      expect(copy.fallbacks).toEqual(['previouslyDeleted:trash']);
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(mocks.assetDeletedChecksum.markReimported).not.toHaveBeenCalled();
    });

    it('never stacks the asset of a previously deleted file', async () => {
      const members = [
        { id: 'rf-a', groupOrder: 0, isCover: true, status: TakeoutRunFileStatus.Done, assetId: 'a', fallbacks: [] },
        {
          id: 'rf-b',
          groupOrder: 1,
          status: TakeoutRunFileStatus.Done,
          assetId: 'b',
          fallbacks: ['previouslyDeleted:trash'],
        },
      ];

      await (sut as any).stackGroup(run(), members, members);

      expect(mocks.stack.create).not.toHaveBeenCalled();
      expect((sut as any).stackPending(members, members)).toBe(false);
    });
    it('never stacks a server duplicate that is in the trash', async () => {
      // family 2026-09-29: an original was stacked with its trashed edited copy, and the trashed cover hid the stack
      const members = [
        {
          id: 'rf-a',
          groupOrder: 0,
          isCover: true,
          action: TakeoutRunFileAction.ServerDuplicate,
          status: TakeoutRunFileStatus.Done,
          assetId: 'a',
          reason: 'already on the server (in trash)',
          fallbacks: [],
        },
        { id: 'rf-b', groupOrder: 1, status: TakeoutRunFileStatus.Done, assetId: 'b', fallbacks: [] },
      ];

      await (sut as any).stackGroup(run(), members, members);

      expect(mocks.stack.create).not.toHaveBeenCalled();
      expect((sut as any).stackPending(members, members)).toBe(false);
    });
  });

  describe("a detected rotation, saved as an edit and rendered like the media repository, gives Google's copy", () => {
    // family 2026-10-05: 90 and 270 degree rotations were saved as 360 - angle and showed upside down
    const W = 120;
    const H = 80;
    // asymmetric pattern: a bright block in the top left corner and a horizontal gradient
    const raw = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = x < W / 3 && y < H / 3 ? 255 : Math.floor((x * 200) / W);
        raw.fill(v, (y * W + x) * 3, (y * W + x) * 3 + 3);
      }
    }
    const image = () => sharp(raw, { raw: { width: W, height: H, channels: 3 } });
    const sampleOf = async (png: Buffer) => {
      const result = await computeImageSample(png);
      if ('skipped' in result) {
        throw new Error(result.skipped);
      }
      return result;
    };

    for (const googleAngle of [90, 180, 270]) {
      it(`Google turned the photo ${googleAngle} degrees clockwise`, async () => {
        const original = await sampleOf(await image().png().toBuffer());
        const googleCopy = await sampleOf(await image().rotate(googleAngle).png().toBuffer());
        const detected = detectRotationFromSamples(original, googleCopy);
        expect(detected).toBe(googleAngle);

        mocks.asset.getById.mockResolvedValue({
          type: 'IMAGE',
          originalPath: '/x/a.jpg',
          exifInfo: { exifImageWidth: W, exifImageHeight: H },
          edits: [],
        } as any);
        mocks.assetEdit.replaceAll.mockResolvedValue(undefined as any);
        await (sut as any).applyRotationNow('asset-a', detected);

        const [, edits] = mocks.assetEdit.replaceAll.mock.calls[0] as any;
        expect(edits).toHaveLength(1);
        expect(edits[0].action).toBe(AssetEditAction.Rotate);
        // a rotate edit is rendered with sharp.rotate(angle) (media.repository), which turns clockwise
        const rendered = await sampleOf(await image().rotate(edits[0].parameters.angle).png().toBuffer());
        expect(detectRotationFromSamples(original, rendered)).toBe(googleAngle);
        expect(detectRotationFromSamples(googleCopy, rendered)).toBe(0);
      });
    }
  });

  describe('phaseRotateFaces: section 11 D1 rotate-only face reconciliation', () => {
    it('rotates the original, re-detects faces, reconciles the copy people, then drops the copy in that order', async () => {
      const original = {
        id: 'rf-orig',
        seq: 0,
        assetId: 'asset-orig',
        status: TakeoutRunFileStatus.Created,
        action: TakeoutRunFileAction.Upload,
        rotation: 90,
        plan: { rotateOriginal: true, rotateAngle: 90, rotateCopySeqs: [1], tags: ['People/Alice'] },
      };
      const copy = {
        id: 'rf-copy',
        seq: 1,
        assetId: null,
        status: TakeoutRunFileStatus.Skipped,
        action: TakeoutRunFileAction.RotateOnlyDropped,
        plan: { rotateCopyOf: 0, tags: ['People/Bob'] },
      };

      mocks.asset.getById.mockResolvedValue({
        type: 'IMAGE',
        originalPath: '/x/asset-orig.jpg',
        exifInfo: { exifImageWidth: 100, exifImageHeight: 200 },
        edits: [],
      } as any);
      mocks.job.run.mockResolvedValue(undefined as any);
      mocks.assetEdit.replaceAll.mockResolvedValue(undefined as any);
      mocks.tag.upsertValue.mockImplementation(
        ({ value }: any) => Promise.resolve({ id: `tag-${value}`, value }) as any,
      );

      await (sut as any).phaseRotateFaces(run(), settings(), [original, copy]);

      // rotation edit applied to the original, clockwise like the detected angle
      expect(mocks.assetEdit.replaceAll).toHaveBeenCalledWith('asset-orig', [
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);
      // face detection queued + awaited on the original
      expect(mocks.job.run).toHaveBeenCalledWith({
        name: JobName.AssetDetectFaces,
        data: { id: 'asset-orig', source: 'upload' },
      });
      // the copy's named people reconciled onto the original
      expect(mocks.tag.upsertAssetIds).toHaveBeenCalled();
      const assignedTagIds = mocks.tag.upsertAssetIds.mock.calls[0][0].map((t: any) => t.tagId);
      expect(assignedTagIds).toEqual(expect.arrayContaining(['tag-People/Alice', 'tag-People/Bob']));
      // the copy is dropped last: its Done transition happens after the rotation edit and face detection
      const dropCall = mocks.takeout.updateRunFile.mock.calls.find(
        (c) => c[0] === 'rf-copy' && (c[1] as any)?.status === TakeoutRunFileStatus.Done,
      );
      expect(dropCall).toBeTruthy();
      const dropOrder = mocks.takeout.updateRunFile.mock.invocationCallOrder.at(-1)!;
      expect(mocks.assetEdit.replaceAll.mock.invocationCallOrder[0]).toBeLessThan(dropOrder);
      expect(mocks.job.run.mock.invocationCallOrder.at(-1)!).toBeLessThan(dropOrder);
    });

    it('leaves the rotation of an existing-asset original to D1: never pending for the hook', async () => {
      const row = {
        id: 'rf-dup',
        seq: 2,
        assetId: null,
        dependsOnSeq: 0,
        status: TakeoutRunFileStatus.Planned,
        action: TakeoutRunFileAction.AlreadyProcessed,
        rotation: 90,
        plan: { rotateOriginal: true, rotateAngle: 90, rotateCopySeqs: [3], tags: [] },
      };
      const source = { id: 'rf-orig', seq: 0, assetId: 'asset-orig', status: TakeoutRunFileStatus.Done };
      mocks.asset.getByIds.mockResolvedValue([{ id: 'asset-orig' }] as any);
      // extraction has not run yet: no EXIF dimensions
      mocks.asset.getById.mockResolvedValue({ type: 'IMAGE', exifInfo: {}, edits: [] } as any);

      await (sut as any).processExisting(run(), { ...settings(), applyRotation: true }, row, [source, row]);

      const states = mocks.takeout.updateRunFile.mock.calls.map((call) => (call[1] as any).rotationState);
      expect(states.filter((state) => state !== undefined)).toEqual([]);
      expect(row.status).toBe(TakeoutRunFileStatus.Done);
      expect(row.assetId).toBe('asset-orig');
    });

    it('rotates an asset once when two originals share it, and reports the same state on both', async () => {
      const edits: unknown[] = [];
      mocks.asset.getById.mockImplementation(
        () =>
          Promise.resolve({
            type: 'IMAGE',
            originalPath: '/x/asset-orig.jpg',
            exifInfo: { exifImageWidth: 100, exifImageHeight: 200 },
            edits: [...edits],
          }) as any,
      );
      mocks.assetEdit.replaceAll.mockImplementation(((_id: string, list: unknown[]) => {
        edits.push(...list);
        return Promise.resolve();
      }) as any);
      mocks.job.run.mockResolvedValue(undefined as any);

      await (sut as any).phaseRotateFaces(run(), settings(), [
        sharedOriginal('rf-a', 0, 1),
        droppedCopy('rf-a-copy', 1, 0),
        sharedOriginal('rf-b', 2, 3),
        droppedCopy('rf-b-copy', 3, 2),
      ]);

      expect(mocks.assetEdit.replaceAll).toHaveBeenCalledTimes(1);
      const states = mocks.takeout.updateRunFile.mock.calls
        .filter((call) => (call[1] as any).rotationState !== undefined)
        .map((call) => [call[0], (call[1] as any).rotationState]);
      expect(states).toEqual([
        ['rf-a', 'applied'],
        ['rf-b', 'applied'],
      ]);
      const detections = mocks.job.run.mock.calls.filter((call) => (call[0] as any).name === JobName.AssetDetectFaces);
      expect(detections).toHaveLength(1);
    });

    it('never drops the copy when the original was not created', async () => {
      const original = {
        id: 'rf-orig',
        seq: 0,
        assetId: null,
        status: TakeoutRunFileStatus.Planned,
        action: TakeoutRunFileAction.Upload,
        rotation: 90,
        plan: { rotateOriginal: true, rotateAngle: 90, rotateCopySeqs: [1], tags: [] },
      };
      const copy = { id: 'rf-copy', seq: 1, status: TakeoutRunFileStatus.Skipped, plan: { rotateCopyOf: 0, tags: [] } };

      await (sut as any).phaseRotateFaces(run(), settings(), [original, copy]);

      expect(mocks.job.run).not.toHaveBeenCalled();
      expect(mocks.assetEdit.replaceAll).not.toHaveBeenCalled();
      expect(mocks.takeout.updateRunFile).not.toHaveBeenCalled();
    });
  });

  describe('verifyAndRequeue: finding T9/#9 post-import verification', () => {
    it('re-queues only the jobs that did not run for each created asset', async () => {
      const rows = [
        { assetId: 'a-img', action: TakeoutRunFileAction.Upload, status: TakeoutRunFileStatus.Done },
        { assetId: 'a-vid', action: TakeoutRunFileAction.Upload, status: TakeoutRunFileStatus.Created },
        { assetId: 'a-dupe', action: TakeoutRunFileAction.ServerDuplicate, status: TakeoutRunFileStatus.Done },
      ];
      mocks.takeout.getPostImportState.mockResolvedValue([
        // image is fully done -> nothing re-queued
        {
          id: 'a-img',
          type: AssetType.Image,
          hasThumbhash: true,
          metadataDone: true,
          hasPreview: true,
          hasThumbnail: true,
          hasEncodedVideo: false,
        },
        // video is missing metadata, thumbnail and its encoded video -> all three re-queued
        {
          id: 'a-vid',
          type: AssetType.Video,
          hasThumbhash: false,
          metadataDone: false,
          hasPreview: false,
          hasThumbnail: false,
          hasEncodedVideo: false,
        },
      ] as any);

      await (sut as any).verifyAndRequeue(rows);

      // only the two uploaded assets are checked (server duplicate excluded)
      expect(mocks.takeout.getPostImportState).toHaveBeenCalledWith(['a-img', 'a-vid']);
      const queued = mocks.job.queueAll.mock.calls[0][0].map((j: any) => j.name);
      expect(queued).toEqual(
        expect.arrayContaining([
          JobName.AssetExtractMetadata,
          JobName.AssetGenerateThumbnails,
          JobName.AssetEncodeVideo,
        ]),
      );
      // the fully-done image contributed no jobs
      expect(queued.filter((n: string) => n === JobName.AssetGenerateThumbnails)).toHaveLength(1);
    });

    it('queues nothing when there are no created upload assets', async () => {
      await (sut as any).verifyAndRequeue([
        { assetId: 'x', action: TakeoutRunFileAction.ServerDuplicate, status: TakeoutRunFileStatus.Done },
      ]);
      expect(mocks.takeout.getPostImportState).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });
  });
});
