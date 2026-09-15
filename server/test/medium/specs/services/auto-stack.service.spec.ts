import { Kysely } from 'kysely';
import {
  JobName,
  JobStatus,
  StackAutoExclusionReason,
  StackSource,
  StackUserEditAction,
  UserMetadataKey,
} from 'src/enum';
import { AssetRepository } from 'src/repositories/asset.repository';
import { AutoStackRepository } from 'src/repositories/auto-stack.repository';
import { ConfigRepository } from 'src/repositories/config.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PersonRepository } from 'src/repositories/person.repository';
import { SearchRepository } from 'src/repositories/search.repository';
import { StackRepository } from 'src/repositories/stack.repository';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { WebsocketRepository } from 'src/repositories/websocket.repository';
import { DB } from 'src/schema';
import { AutoStackService } from 'src/services/auto-stack.service';
import { clearConfigCache } from 'src/utils/config';
import { MediumTestContext, newMediumService } from 'test/medium.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(AutoStackService, {
    database: db || defaultDatabase,
    real: [
      AssetRepository,
      AutoStackRepository,
      ConfigRepository,
      PersonRepository,
      SearchRepository,
      StackRepository,
      SystemMetadataRepository,
      UserRepository,
    ],
    mock: [EventRepository, JobRepository, LoggingRepository, WebsocketRepository],
  });

  ctx.getMock(EventRepository).emit.mockResolvedValue();
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();

  return { sut, ctx };
};

/** a 512 dimension embedding pointing mostly along `index`, `tilt` adds a little of the next axis */
const embedding = (index: number, tilt = 0) =>
  JSON.stringify(Array.from({ length: 512 }, (_, i) => (i === index ? 1 : i === index + 1 ? tilt : 0)));

const start = new Date('2026-09-10T10:00:00.000Z').getTime();

const newUserWithAutoStacks = async (ctx: MediumTestContext, enabled = true) => {
  const { user } = await ctx.newUser();
  await ctx.get(UserRepository).upsertMetadata(user.id, {
    key: UserMetadataKey.Preferences,
    value: { autoStack: { enabled } },
  });
  return user;
};

const newPhoto = async (
  ctx: MediumTestContext,
  ownerId: string,
  seconds: number,
  options: {
    vector?: string;
    isFavorite?: boolean;
    isPrivate?: boolean;
    make?: string;
    originalFileName?: string;
  } = {},
) => {
  const { asset } = await ctx.newAsset({
    ownerId,
    fileCreatedAt: new Date(start + seconds * 1000),
    localDateTime: new Date(start + seconds * 1000),
    createdAt: new Date('2026-09-11T00:00:00.000Z'),
    isFavorite: options.isFavorite ?? false,
    isPrivate: options.isPrivate ?? false,
    originalFileName: options.originalFileName ?? `PXL_${seconds}.jpg`,
  });
  await ctx.newExif({ assetId: asset.id, make: options.make ?? 'Google', model: 'Pixel 9 Pro XL' });
  await ctx.get(SearchRepository).upsert(asset.id, options.vector ?? embedding(0));
  await ctx.newJobStatus({ assetId: asset.id, facesRecognizedAt: new Date('2026-09-11T00:00:00.000Z') });
  return asset;
};

const getStackOf = (ctx: MediumTestContext, assetId: string) =>
  ctx.database
    .selectFrom('asset')
    .innerJoin('stack', 'stack.id', 'asset.stackId')
    .select(['stack.id', 'stack.primaryAssetId', 'stack.source'])
    .where('asset.id', '=', assetId)
    .executeTakeFirst();

const getStackMembers = async (ctx: MediumTestContext, stackId: string) => {
  const rows = await ctx.database.selectFrom('asset').select('id').where('stackId', '=', stackId).execute();
  return rows.map(({ id }) => id).sort();
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

beforeEach(() => {
  clearConfigCache();
});

const newFaceWithAttributes = async (
  ctx: MediumTestContext,
  assetId: string,
  attributes: { eyeBlinkLeft: number; eyeBlinkRight: number; smile: number; yaw: number; sharpness: number },
) => {
  const { assetFace } = await ctx.newAssetFace({
    assetId,
    imageWidth: 1000,
    imageHeight: 1000,
    boundingBoxX1: 400,
    boundingBoxY1: 400,
    boundingBoxX2: 600,
    boundingBoxY2: 600,
  });
  await ctx.database
    .insertInto('asset_face_attribute')
    .values({
      faceId: assetFace.id,
      detected: true,
      modelName: 'face_landmarker',
      pitch: 0,
      roll: 0,
      ...attributes,
    })
    .execute();
};

const newQuality = (ctx: MediumTestContext, assetId: string, sharpness: number) =>
  ctx.database
    .insertInto('asset_quality')
    .values({ assetId, sharpness, exposureClipped: 0.01, brightness: 0.5, modelName: 'laplacian' })
    .execute();

describe(AutoStackService.name, () => {
  describe('handleAutoStack', () => {
    it('should stack a burst with the favorite on top and leave other shots alone', async () => {
      const { sut, ctx } = setup();
      const user = await newUserWithAutoStacks(ctx);
      const a = await newPhoto(ctx, user.id, 0);
      const b = await newPhoto(ctx, user.id, 1, { vector: embedding(0, 0.05), isFavorite: true });
      const c = await newPhoto(ctx, user.id, 2, { vector: embedding(0, 0.1) });
      const otherScene = await newPhoto(ctx, user.id, 3, { vector: embedding(7) });
      const later = await newPhoto(ctx, user.id, 13);

      await expect(sut.handleAutoStack({ id: a.id })).resolves.toBe(JobStatus.Success);

      const stack = await getStackOf(ctx, a.id);
      expect(stack).toEqual({ id: expect.any(String), primaryAssetId: b.id, source: StackSource.Auto });
      expect(await getStackMembers(ctx, stack!.id)).toEqual([a.id, b.id, c.id].sort());
      await expect(getStackOf(ctx, otherScene.id)).resolves.toBeUndefined();
      await expect(getStackOf(ctx, later.id)).resolves.toBeUndefined();

      const statuses = await ctx.database
        .selectFrom('asset_job_status')
        .select(['assetId', 'autoStackedAt'])
        .where('assetId', 'in', [a.id, b.id, c.id, otherScene.id, later.id])
        .execute();
      const evaluated = statuses.filter(({ autoStackedAt }) => autoStackedAt).map(({ assetId }) => assetId);
      expect(evaluated.sort()).toEqual([a.id, b.id, c.id, otherScene.id].sort());

      // a neighbour evaluated with the burst is skipped
      await expect(sut.handleAutoStack({ id: c.id })).resolves.toBe(JobStatus.Skipped);
    });

    it('should do nothing for a user who did not turn automatic stacks on', async () => {
      const { sut, ctx } = setup();
      const user = await newUserWithAutoStacks(ctx, false);
      const a = await newPhoto(ctx, user.id, 0);
      await newPhoto(ctx, user.id, 1);

      await expect(sut.handleAutoStack({ id: a.id })).resolves.toBe(JobStatus.Skipped);
      await expect(getStackOf(ctx, a.id)).resolves.toBeUndefined();
    });

    it('should never touch a manual stack', async () => {
      const { sut, ctx } = setup();
      const user = await newUserWithAutoStacks(ctx);
      const a = await newPhoto(ctx, user.id, 0);
      const b = await newPhoto(ctx, user.id, 1);
      const c = await newPhoto(ctx, user.id, 2);
      const { stack } = await ctx.newStack({ ownerId: user.id }, [a.id, b.id]);

      await expect(sut.handleAutoStack({ id: c.id })).resolves.toBe(JobStatus.Success);

      expect(await getStackMembers(ctx, stack.id)).toEqual([a.id, b.id].sort());
      await expect(getStackOf(ctx, a.id)).resolves.toMatchObject({ id: stack.id, source: StackSource.Manual });
      await expect(getStackOf(ctx, c.id)).resolves.toBeUndefined();
    });

    it('should make the whole stack private when one photo is private', async () => {
      const { sut, ctx } = setup();
      const user = await newUserWithAutoStacks(ctx);
      const a = await newPhoto(ctx, user.id, 0);
      const b = await newPhoto(ctx, user.id, 1, { isPrivate: true });

      await expect(sut.handleAutoStack({ id: a.id })).resolves.toBe(JobStatus.Success);

      const rows = await ctx.database
        .selectFrom('asset')
        .select(['id', 'isPrivate', 'stackId'])
        .where('id', 'in', [a.id, b.id])
        .execute();
      expect(rows.every(({ isPrivate, stackId }) => isPrivate && stackId)).toBe(true);
      expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AssetPrivateUpdateAll', {
        assetIds: [a.id],
        userId: user.id,
      });
    });

    it('should grow an automatic stack when a late upload joins the burst', async () => {
      const { sut, ctx } = setup();
      const user = await newUserWithAutoStacks(ctx);
      const a = await newPhoto(ctx, user.id, 0);
      const c = await newPhoto(ctx, user.id, 2);

      await sut.handleAutoStack({ id: a.id });
      const first = await getStackOf(ctx, a.id);
      expect(first?.source).toBe(StackSource.Auto);

      const late = await newPhoto(ctx, user.id, 1, { isFavorite: true });
      await expect(sut.handleAutoStack({ id: late.id })).resolves.toBe(JobStatus.Success);

      const second = await getStackOf(ctx, late.id);
      expect(second).toMatchObject({ primaryAssetId: late.id, source: StackSource.Auto });
      expect(await getStackMembers(ctx, second!.id)).toEqual([a.id, c.id, late.id].sort());
      const stacks = await ctx.database.selectFrom('stack').select('id').where('ownerId', '=', user.id).execute();
      expect(stacks).toHaveLength(1);
    });

    it('should not recreate a stack the user unstacked, even after a full run', async () => {
      const { sut, ctx } = setup();
      const user = await newUserWithAutoStacks(ctx);
      const a = await newPhoto(ctx, user.id, 0);
      const b = await newPhoto(ctx, user.id, 1);

      await sut.handleAutoStack({ id: a.id });
      const stack = await getStackOf(ctx, a.id);
      expect(stack?.source).toBe(StackSource.Auto);

      // what the stack endpoint does when the user unstacks
      await ctx.get(StackRepository).delete(stack!.id);
      await sut.onStackUserEdit({
        userId: user.id,
        stackId: stack!.id,
        source: StackSource.Auto,
        action: StackUserEditAction.Delete,
        assetIds: [a.id, b.id],
      });

      const exclusions = await ctx.get(AutoStackRepository).getExclusions([a.id, b.id]);
      expect(exclusions.map(({ reason }) => reason)).toEqual([
        StackAutoExclusionReason.Unstacked,
        StackAutoExclusionReason.Unstacked,
      ]);

      await ctx.get(AutoStackRepository).resetAutoStackedAt();
      await expect(sut.handleAutoStack({ id: a.id })).resolves.toBe(JobStatus.Success);
      await expect(getStackOf(ctx, a.id)).resolves.toBeUndefined();
      await expect(getStackOf(ctx, b.id)).resolves.toBeUndefined();
    });

    it('should keep the cover the user picked when the job runs again', async () => {
      const { sut, ctx } = setup();
      const user = await newUserWithAutoStacks(ctx);
      const a = await newPhoto(ctx, user.id, 0, { isFavorite: true });
      const b = await newPhoto(ctx, user.id, 1);

      await sut.handleAutoStack({ id: a.id });
      const stack = await getStackOf(ctx, a.id);
      expect(stack?.primaryAssetId).toBe(a.id);

      await ctx
        .get(StackRepository)
        .update(stack!.id, { primaryAssetId: b.id }, { privateMode: true, userId: user.id });
      await sut.onStackUserEdit({
        userId: user.id,
        stackId: stack!.id,
        source: StackSource.Auto,
        action: StackUserEditAction.UpdatePrimary,
        assetIds: [b.id],
      });

      await ctx.get(AutoStackRepository).resetAutoStackedAt();
      await expect(sut.handleAutoStack({ id: b.id })).resolves.toBe(JobStatus.Success);

      await expect(getStackOf(ctx, a.id)).resolves.toEqual({
        id: stack!.id,
        primaryAssetId: b.id,
        source: StackSource.Auto,
      });
    });

    it('should not add a photo the user took out of an automatic stack', async () => {
      const { sut, ctx } = setup();
      const user = await newUserWithAutoStacks(ctx);
      const a = await newPhoto(ctx, user.id, 0);
      const b = await newPhoto(ctx, user.id, 1);
      const c = await newPhoto(ctx, user.id, 2);

      await sut.handleAutoStack({ id: a.id });
      const stack = await getStackOf(ctx, a.id);
      expect(await getStackMembers(ctx, stack!.id)).toHaveLength(3);

      const removed = stack!.primaryAssetId === c.id ? b : c;
      await ctx.get(AssetRepository).update({ id: removed.id, stackId: null });
      await sut.onStackUserEdit({
        userId: user.id,
        stackId: stack!.id,
        source: StackSource.Auto,
        action: StackUserEditAction.RemoveAssets,
        assetIds: [removed.id],
      });

      await ctx.get(AutoStackRepository).resetAutoStackedAt();
      await sut.handleAutoStack({ id: removed.id });

      await expect(getStackOf(ctx, removed.id)).resolves.toBeUndefined();
      const current = await getStackOf(ctx, a.id);
      expect(current).toBeDefined();
      expect(await getStackMembers(ctx, current!.id)).not.toContain(removed.id);
    });
  });

  describe('face attributes', () => {
    it('should pick the photo with open eyes over a sharper photo with closed eyes', async () => {
      const { sut, ctx } = setup();
      const user = await newUserWithAutoStacks(ctx);
      const blink = await newPhoto(ctx, user.id, 0);
      const open = await newPhoto(ctx, user.id, 1);
      await newFaceWithAttributes(ctx, blink.id, {
        eyeBlinkLeft: 0.9,
        eyeBlinkRight: 0.8,
        smile: 0.5,
        yaw: 0,
        sharpness: 300,
      });
      await newFaceWithAttributes(ctx, open.id, {
        eyeBlinkLeft: 0.05,
        eyeBlinkRight: 0.1,
        smile: 0.3,
        yaw: 3,
        sharpness: 90,
      });
      await newQuality(ctx, blink.id, 400);
      await newQuality(ctx, open.id, 120);

      await expect(sut.handleAutoStack({ id: blink.id })).resolves.toBe(JobStatus.Success);

      await expect(getStackOf(ctx, blink.id)).resolves.toMatchObject({ primaryAssetId: open.id });
    });

    it('should split when the head turns', async () => {
      const { sut, ctx } = setup();
      const user = await newUserWithAutoStacks(ctx);
      const front = await newPhoto(ctx, user.id, 0);
      const side = await newPhoto(ctx, user.id, 1);
      await newFaceWithAttributes(ctx, front.id, {
        eyeBlinkLeft: 0,
        eyeBlinkRight: 0,
        smile: 0.5,
        yaw: 0,
        sharpness: 90,
      });
      await newFaceWithAttributes(ctx, side.id, {
        eyeBlinkLeft: 0,
        eyeBlinkRight: 0,
        smile: 0.5,
        yaw: 30,
        sharpness: 90,
      });

      await expect(sut.handleAutoStack({ id: front.id })).resolves.toBe(JobStatus.Success);

      await expect(getStackOf(ctx, front.id)).resolves.toBeUndefined();
    });

    it('should split when the expression changes', async () => {
      const { sut, ctx } = setup();
      const user = await newUserWithAutoStacks(ctx);
      const neutral = await newPhoto(ctx, user.id, 0);
      const smiling = await newPhoto(ctx, user.id, 1);
      await newFaceWithAttributes(ctx, neutral.id, {
        eyeBlinkLeft: 0.05,
        eyeBlinkRight: 0.05,
        smile: 0,
        yaw: 0,
        sharpness: 90,
      });
      await newFaceWithAttributes(ctx, smiling.id, {
        eyeBlinkLeft: 0.05,
        eyeBlinkRight: 0.05,
        smile: 0.76,
        yaw: 0,
        sharpness: 90,
      });

      await expect(sut.handleAutoStack({ id: neutral.id })).resolves.toBe(JobStatus.Success);

      await expect(getStackOf(ctx, neutral.id)).resolves.toBeUndefined();
    });

    it('should wait while a new upload in the burst has no face attributes yet', async () => {
      const { sut, ctx } = setup();
      const user = await newUserWithAutoStacks(ctx);
      const a = await newPhoto(ctx, user.id, 0);
      const b = await newPhoto(ctx, user.id, 1);
      await newQuality(ctx, a.id, 100);
      await ctx.database.updateTable('asset').set({ createdAt: new Date() }).where('id', '=', b.id).execute();

      await expect(sut.handleAutoStack({ id: a.id })).resolves.toBe(JobStatus.Skipped);
      await expect(getStackOf(ctx, a.id)).resolves.toBeUndefined();

      await newQuality(ctx, b.id, 100);
      await expect(sut.handleAutoStack({ id: b.id })).resolves.toBe(JobStatus.Success);
      await expect(getStackOf(ctx, a.id)).resolves.toBeDefined();
    });
  });

  describe('handleQueueAutoStack', () => {
    it('should queue only the unevaluated assets of users who turned automatic stacks on', async () => {
      const { sut, ctx } = setup();
      const user = await newUserWithAutoStacks(ctx);
      const other = await newUserWithAutoStacks(ctx, false);
      const a = await newPhoto(ctx, user.id, 0);
      const evaluated = await newPhoto(ctx, user.id, 100);
      await ctx.get(AutoStackRepository).setAutoStackedAt([evaluated.id], new Date());
      await newPhoto(ctx, other.id, 0);

      await expect(sut.handleQueueAutoStack({ force: false })).resolves.toBe(JobStatus.Success);

      const queued = ctx
        .getMock(JobRepository)
        .queueAll.mock.calls.flatMap(([items]) => items)
        .map((item) => (item as { data: { id: string } }).data.id);
      expect(queued).toContain(a.id);
      expect(queued).not.toContain(evaluated.id);
      expect(ctx.getMock(JobRepository).queueAll).toHaveBeenCalledWith(
        expect.arrayContaining([{ name: JobName.AutoStack, data: { id: a.id } }]),
      );

      ctx.getMock(JobRepository).queueAll.mockClear();
      await sut.handleQueueAutoStack({ force: true });
      const requeued = ctx
        .getMock(JobRepository)
        .queueAll.mock.calls.flatMap(([items]) => items)
        .map((item) => (item as { data: { id: string } }).data.id);
      expect(requeued).toEqual(expect.arrayContaining([a.id, evaluated.id]));
    });
  });
});
