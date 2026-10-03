import { Kysely } from 'kysely';
import { StackSource, SyncEntityType, SyncRequestType } from 'src/enum';
import { AssetRepository } from 'src/repositories/asset.repository';
import { StackRepository } from 'src/repositories/stack.repository';
import { DB } from 'src/schema';
import { SyncTestContext } from 'test/medium.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = async (db?: Kysely<DB>) => {
  const ctx = new SyncTestContext(db || defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  return { auth, user, session, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(SyncEntityType.StackV1, () => {
  it('should detect and sync the first stack', async () => {
    const { auth, user, ctx } = await setup();
    const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
    const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
    const { stack } = await ctx.newStack({ ownerId: user.id }, [asset1.id, asset2.id]);

    const response = await ctx.syncStream(auth, [SyncRequestType.StacksV1]);
    expect(response).toEqual([
      {
        ack: expect.stringContaining('StackV1'),
        data: {
          id: stack.id,
          createdAt: (stack.createdAt as Date).toISOString(),
          updatedAt: (stack.updatedAt as Date).toISOString(),
          primaryAssetId: stack.primaryAssetId,
          ownerId: stack.ownerId,
        },
        type: 'StackV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.StacksV1]);
  });

  it('should detect and sync a deleted stack', async () => {
    const { auth, user, ctx } = await setup();
    const stackRepo = ctx.get(StackRepository);
    const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
    const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
    const { stack } = await ctx.newStack({ ownerId: user.id }, [asset1.id, asset2.id]);
    await stackRepo.delete(stack.id);

    const response = await ctx.syncStream(auth, [SyncRequestType.StacksV1]);
    expect(response).toEqual([
      {
        ack: expect.stringContaining('StackDeleteV1'),
        data: { stackId: stack.id },
        type: 'StackDeleteV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.StacksV1]);
  });

  it('should sync a stack and then an update to that same stack', async () => {
    const { auth, user, ctx } = await setup();
    const stackRepo = ctx.get(StackRepository);
    const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
    const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
    const { stack } = await ctx.newStack({ ownerId: user.id }, [asset1.id, asset2.id]);

    const response = await ctx.syncStream(auth, [SyncRequestType.StacksV1]);
    expect(response).toEqual([
      expect.objectContaining({ type: SyncEntityType.StackV1 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.syncAckAll(auth, response);

    await stackRepo.update(stack.id, { primaryAssetId: asset2.id }, { privateMode: true, userId: user.id });
    const newResponse = await ctx.syncStream(auth, [SyncRequestType.StacksV1]);
    expect(newResponse).toEqual([
      expect.objectContaining({ type: SyncEntityType.StackV1 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    expect(newResponse).toEqual([
      {
        ack: expect.stringContaining('StackV1'),
        data: expect.objectContaining({ id: stack.id, primaryAssetId: asset2.id }),
        type: 'StackV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, newResponse);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.StacksV1]);
  });

  it('should not sync a stack or stack delete for an unrelated user', async () => {
    const { auth, ctx } = await setup();
    const stackRepo = ctx.get(StackRepository);
    const { user: user2 } = await ctx.newUser();
    const { asset: asset1 } = await ctx.newAsset({ ownerId: user2.id });
    const { asset: asset2 } = await ctx.newAsset({ ownerId: user2.id });
    const { stack } = await ctx.newStack({ ownerId: user2.id }, [asset1.id, asset2.id]);

    await ctx.assertSyncIsComplete(auth, [SyncRequestType.StacksV1]);
    await stackRepo.delete(stack.id);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.StacksV1]);
  });
  describe('private assets and the includePrivate flag', () => {
    it('should withhold a stack whose primary asset is private and send it again once it is public and touched', async () => {
      const { auth, user, ctx } = await setup();
      const assetRepo = ctx.get(AssetRepository);
      const { asset: primary } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { asset: other } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { stack } = await ctx.newStack({ ownerId: user.id }, [primary.id, other.id]);

      const withheld = await ctx.syncStream(auth, [SyncRequestType.StacksV1]);
      expect(withheld.map(({ type }) => type)).not.toContain(SyncEntityType.StackV1);
      await ctx.syncAckAll(auth, withheld);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.StacksV1]);

      await assetRepo.updateAll([primary.id, other.id], { isPrivate: false });
      await assetRepo.touchPrivateRelations([primary.id, other.id]);
      const restored = await ctx.syncStream(auth, [SyncRequestType.StacksV1]);
      expect(restored).toEqual([
        expect.objectContaining({
          type: SyncEntityType.StackV1,
          data: expect.objectContaining({ id: stack.id, primaryAssetId: primary.id }),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, restored);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.StacksV1]);
    });

    it('should carry a stack whose primary asset is private for a client that opted in', async () => {
      const { auth, user, ctx } = await setup();
      const { asset } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { stack } = await ctx.newStack({ ownerId: user.id }, [asset.id]);

      await expect(ctx.syncStream(auth, [SyncRequestType.StacksV1], false, true)).resolves.toEqual([
        expect.objectContaining({ type: SyncEntityType.StackV1, data: expect.objectContaining({ id: stack.id }) }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
    });
  });
});

describe(SyncEntityType.StackV2, () => {
  it('should sync the source of manual and automatic stacks', async () => {
    const { auth, user, ctx } = await setup();
    const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
    const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
    const { asset: asset3 } = await ctx.newAsset({ ownerId: user.id });
    const { asset: asset4 } = await ctx.newAsset({ ownerId: user.id });
    const { stack: manual } = await ctx.newStack({ ownerId: user.id }, [asset1.id, asset2.id]);
    const { stack: auto } = await ctx.newStack({ ownerId: user.id, source: StackSource.Auto }, [asset3.id, asset4.id]);

    const response = await ctx.syncStream(auth, [SyncRequestType.StacksV2]);
    expect(response).toEqual([
      {
        ack: expect.stringContaining('StackV2'),
        data: {
          id: manual.id,
          createdAt: (manual.createdAt as Date).toISOString(),
          updatedAt: (manual.updatedAt as Date).toISOString(),
          primaryAssetId: manual.primaryAssetId,
          ownerId: manual.ownerId,
          source: StackSource.Manual,
        },
        type: SyncEntityType.StackV2,
      },
      {
        ack: expect.stringContaining('StackV2'),
        data: expect.objectContaining({ id: auto.id, source: StackSource.Auto }),
        type: SyncEntityType.StackV2,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.StacksV2]);
  });

  it('should leave the source out of StackV1 for clients that do not know it', async () => {
    const { auth, user, ctx } = await setup();
    const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
    const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newStack({ ownerId: user.id, source: StackSource.Auto }, [asset1.id, asset2.id]);

    const response = await ctx.syncStream(auth, [SyncRequestType.StacksV1]);
    expect(response).toHaveLength(2);
    expect(response[0].type).toBe(SyncEntityType.StackV1);
    expect(response[0].data).not.toHaveProperty('source');
  });

  it('should send every stack again to a client that moves from V1 to V2', async () => {
    const { auth, user, ctx } = await setup();
    const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
    const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
    const { stack } = await ctx.newStack({ ownerId: user.id, source: StackSource.Auto }, [asset1.id, asset2.id]);

    const v1 = await ctx.syncStream(auth, [SyncRequestType.StacksV1]);
    await ctx.syncAckAll(auth, v1);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.StacksV1]);

    await expect(ctx.syncStream(auth, [SyncRequestType.StacksV2])).resolves.toEqual([
      expect.objectContaining({
        type: SyncEntityType.StackV2,
        data: expect.objectContaining({ id: stack.id, source: StackSource.Auto }),
      }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });

  it('should withhold an automatic stack whose primary asset is private unless the client opted in', async () => {
    const { auth, user, ctx } = await setup();
    const { asset: primary } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
    const { asset: other } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
    const { stack } = await ctx.newStack({ ownerId: user.id, source: StackSource.Auto }, [primary.id, other.id]);

    const withheld = await ctx.syncStream(auth, [SyncRequestType.StacksV2]);
    expect(withheld.map(({ type }) => type)).not.toContain(SyncEntityType.StackV2);

    await expect(ctx.syncStream(auth, [SyncRequestType.StacksV2], true, true)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: SyncEntityType.StackV2, data: expect.objectContaining({ id: stack.id }) }),
      ]),
    );
  });
});
