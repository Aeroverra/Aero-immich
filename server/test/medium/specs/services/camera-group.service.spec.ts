import { Kysely } from 'kysely';
import {
  AssetType,
  AssetVisibility,
  JobStatus,
  StackAutoExclusionReason,
  StackSource,
  UserMetadataKey,
} from 'src/enum';
import { AssetRepository } from 'src/repositories/asset.repository';
import { AutoStackRepository } from 'src/repositories/auto-stack.repository';
import { ConfigRepository } from 'src/repositories/config.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { StackRepository } from 'src/repositories/stack.repository';
import { TagRepository } from 'src/repositories/tag.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { DB } from 'src/schema';
import { CameraGroupService } from 'src/services/camera-group.service';
import { MediumTestContext, newMediumService } from 'test/medium.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(CameraGroupService, {
    database: db || defaultDatabase,
    real: [
      AssetRepository,
      AutoStackRepository,
      ConfigRepository,
      DatabaseRepository,
      StackRepository,
      TagRepository,
      UserRepository,
    ],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });

  ctx.getMock(EventRepository).emit.mockResolvedValue();
  ctx.getMock(JobRepository).queue.mockResolvedValue();

  return { sut, ctx };
};

const COVER = 'PXL_20250929_175225242.VB-01.COVER.mp4';
const MAIN = 'PXL_20250929_175225242.VB-02.MAIN.mp4';

const newFile = async (
  ctx: MediumTestContext,
  ownerId: string,
  originalFileName: string,
  options: { visibility?: AssetVisibility; isPrivate?: boolean; folder?: string } = {},
) => {
  const { asset } = await ctx.newAsset({
    ownerId,
    originalFileName,
    originalPath: `/upload/${options.folder ?? 'Photos from 2025'}/${originalFileName}`,
    type: originalFileName.endsWith('.mp4') ? AssetType.Video : AssetType.Image,
    visibility: options.visibility ?? AssetVisibility.Timeline,
    isPrivate: options.isPrivate ?? false,
  });
  return asset;
};

const getStack = async (ctx: MediumTestContext, assetId: string) => {
  const stack = await ctx.database
    .selectFrom('asset')
    .innerJoin('stack', 'stack.id', 'asset.stackId')
    .select(['stack.id', 'stack.primaryAssetId', 'stack.source'])
    .where('asset.id', '=', assetId)
    .executeTakeFirst();
  if (!stack) {
    return null;
  }
  const members = await ctx.database.selectFrom('asset').select('id').where('stackId', '=', stack.id).execute();
  return { ...stack, members: members.map(({ id }) => id).toSorted() };
};

const getTagValues = async (ctx: MediumTestContext, assetId: string) => {
  const rows = await ctx.database
    .selectFrom('tag_asset')
    .innerJoin('tag', 'tag.id', 'tag_asset.tagId')
    .select('tag.value')
    .where('tag_asset.assetId', '=', assetId)
    .execute();
  return rows.map(({ value }) => value).toSorted();
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(CameraGroupService.name, () => {
  it('stacks a Video Boost pair from two folders with the MAIN on top and shares its tags', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const cover = await newFile(ctx, user.id, COVER, { folder: 'Mergee DELETE' });
    const main = await newFile(ctx, user.id, MAIN, { folder: 'Download' });
    const other = await newFile(ctx, user.id, 'PXL_20250929_175225242.VB-02.MAIN~2.mp4');

    const { tag: mom } = await ctx.newTag({ userId: user.id, value: 'People/Mom' });
    const { tag: source } = await ctx.newTag({ userId: user.id, value: 'Source/Google Photos/2026-09-07 88tontos' });
    const { tag: unreviewed } = await ctx.newTag({ userId: user.id, value: 'Unreviewed' });
    await ctx.newTagAsset({ tagIds: [mom.id, source.id], assetIds: [cover.id] });
    await ctx.newTagAsset({ tagIds: [unreviewed.id], assetIds: [main.id] });

    await expect(sut.handleStackCameraGroup({ id: main.id })).resolves.toBe(JobStatus.Success);

    const stack = await getStack(ctx, cover.id);
    expect(stack).toMatchObject({ primaryAssetId: main.id, source: StackSource.Manual });
    expect(stack?.members).toEqual([cover.id, main.id].toSorted());
    await expect(getStack(ctx, other.id)).resolves.toBeNull();

    await expect(getTagValues(ctx, cover.id)).resolves.toEqual([
      'People/Mom',
      'Source/Google Photos/2026-09-07 88tontos',
    ]);
    await expect(getTagValues(ctx, main.id)).resolves.toEqual(['People/Mom']);

    // running again finds the pair stacked and changes nothing
    await expect(sut.handleStackCameraGroup({ id: cover.id })).resolves.toBe(JobStatus.Skipped);
  });

  it('does not look at other users', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const cover = await newFile(ctx, user.id, COVER);
    await newFile(ctx, other.id, MAIN);

    await expect(sut.handleStackCameraGroup({ id: cover.id })).resolves.toBe(JobStatus.Skipped);
    await expect(getStack(ctx, cover.id)).resolves.toBeNull();
  });

  it('adds a burst cover from another folder on top of the stack of its frames', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const frame1 = await newFile(ctx, user.id, '00001IMG_00001_BURST20190530194629.jpg');
    const frame2 = await newFile(ctx, user.id, '00002IMG_00002_BURST20190530194629.jpg');
    const { stack } = await ctx.newStack({ ownerId: user.id }, [frame1.id, frame2.id]);
    const cover = await newFile(ctx, user.id, '00000IMG_00000_BURST20190530194629_COVER.jpg', { folder: 'Camera' });

    await expect(sut.handleStackCameraGroup({ id: cover.id })).resolves.toBe(JobStatus.Success);

    await expect(getStack(ctx, cover.id)).resolves.toEqual({
      id: stack.id,
      primaryAssetId: cover.id,
      source: StackSource.Manual,
      members: [cover.id, frame1.id, frame2.id].toSorted(),
    });
  });

  it('stacks a long exposure photo set with the COVER on top and makes it private as a whole', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const cover = await newFile(ctx, user.id, 'PXL_20240411_181110948.LONG_EXPOSURE-01.COVER.jpg', {
      isPrivate: true,
    });
    const original = await newFile(ctx, user.id, 'PXL_20240411_181110948.LONG_EXPOSURE-02.ORIGINAL.jpg');

    await expect(sut.handleStackCameraGroup({ id: original.id })).resolves.toBe(JobStatus.Success);

    await expect(getStack(ctx, original.id)).resolves.toMatchObject({ primaryAssetId: cover.id });
    const updated = await ctx.database
      .selectFrom('asset')
      .select('isPrivate')
      .where('id', '=', original.id)
      .executeTakeFirstOrThrow();
    expect(updated.isPrivate).toBe(true);
  });

  it('leaves a pair alone after the user unstacked it', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const cover = await newFile(ctx, user.id, COVER);
    const main = await newFile(ctx, user.id, MAIN);
    await ctx.get(AutoStackRepository).upsertExclusions([
      { assetId: cover.id, ownerId: user.id, reason: StackAutoExclusionReason.Unstacked },
      { assetId: main.id, ownerId: user.id, reason: StackAutoExclusionReason.Unstacked },
    ]);

    await expect(sut.handleStackCameraGroup({ id: main.id })).resolves.toBe(JobStatus.Skipped);
    await expect(getStack(ctx, main.id)).resolves.toBeNull();
  });

  it('leaves trashed files out', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const cover = await newFile(ctx, user.id, COVER);
    const main = await newFile(ctx, user.id, MAIN);
    await ctx.database.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', main.id).execute();

    await expect(sut.handleStackCameraGroup({ id: cover.id })).resolves.toBe(JobStatus.Skipped);
    await expect(getStack(ctx, cover.id)).resolves.toBeNull();
  });

  it('does nothing when the user turned it off', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    await ctx.get(UserRepository).upsertMetadata(user.id, {
      key: UserMetadataKey.Preferences,
      value: { cameraGroups: { enabled: false } },
    });
    const cover = await newFile(ctx, user.id, COVER);
    await newFile(ctx, user.id, MAIN);

    await expect(sut.handleStackCameraGroup({ id: cover.id })).resolves.toBe(JobStatus.Skipped);
    await expect(getStack(ctx, cover.id)).resolves.toBeNull();
  });
});
