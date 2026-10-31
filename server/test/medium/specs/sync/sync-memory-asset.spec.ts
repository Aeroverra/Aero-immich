import { Kysely } from 'kysely';
import { SyncEntityType, SyncRequestType } from 'src/enum';
import { AssetRepository } from 'src/repositories/asset.repository';
import { MemoryRepository } from 'src/repositories/memory.repository';
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

describe(SyncEntityType.MemoryToAssetV1, () => {
  it('should detect and sync a memory to asset relation', async () => {
    const { auth, user, ctx } = await setup();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { memory } = await ctx.newMemory({ ownerId: user.id });
    await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.MemoryToAssetsV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          memoryId: memory.id,
          assetId: asset.id,
        },
        type: 'MemoryToAssetV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.MemoryToAssetsV1]);
  });

  it('should detect and sync a deleted memory to asset relation', async () => {
    const { auth, user, ctx } = await setup();
    const memoryRepo = ctx.get(MemoryRepository);
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { memory } = await ctx.newMemory({ ownerId: user.id });
    await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });
    await memoryRepo.removeAssetIds(memory.id, [asset.id]);

    const response = await ctx.syncStream(auth, [SyncRequestType.MemoryToAssetsV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          assetId: asset.id,
          memoryId: memory.id,
        },
        type: 'MemoryToAssetDeleteV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.MemoryToAssetsV1]);
  });

  it('should not sync a memory to asset relation or delete for an unrelated user', async () => {
    const { auth, ctx } = await setup();
    const memoryRepo = ctx.get(MemoryRepository);
    const { auth: auth2, user: user2 } = await ctx.newSyncAuthUser();
    const { asset } = await ctx.newAsset({ ownerId: user2.id });
    const { memory } = await ctx.newMemory({ ownerId: user2.id });
    await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });

    expect(await ctx.syncStream(auth2, [SyncRequestType.MemoryToAssetsV1])).toEqual([
      expect.objectContaining({ type: SyncEntityType.MemoryToAssetV1 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.MemoryToAssetsV1]);

    await memoryRepo.removeAssetIds(memory.id, [asset.id]);

    expect(await ctx.syncStream(auth2, [SyncRequestType.MemoryToAssetsV1])).toEqual([
      expect.objectContaining({ type: SyncEntityType.MemoryToAssetDeleteV1 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.MemoryToAssetsV1]);
  });
  describe('private assets and the includePrivate flag', () => {
    it('should withhold every link of a memory holding a private asset until the asset is public and touched', async () => {
      const { auth, user, ctx } = await setup();
      const assetRepo = ctx.get(AssetRepository);
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
      const { memory } = await ctx.newMemory({ ownerId: user.id });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: hidden.id });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: visible.id });

      const withheld = await ctx.syncStream(auth, [SyncRequestType.MemoryToAssetsV1]);
      expect(withheld.map(({ type }) => type)).not.toContain(SyncEntityType.MemoryToAssetV1);
      await ctx.syncAckAll(auth, withheld);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.MemoryToAssetsV1]);

      await assetRepo.updateAll([hidden.id], { isPrivate: false });
      await assetRepo.touchPrivateRelations([hidden.id]);
      const restored = await ctx.syncStream(auth, [SyncRequestType.MemoryToAssetsV1]);
      expect(restored).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: SyncEntityType.MemoryToAssetV1,
            data: { memoryId: memory.id, assetId: hidden.id },
          }),
          expect.objectContaining({
            type: SyncEntityType.MemoryToAssetV1,
            data: { memoryId: memory.id, assetId: visible.id },
          }),
        ]),
      );
      await ctx.syncAckAll(auth, restored);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.MemoryToAssetsV1]);
    });

    it('should carry the links of a memory holding a private asset for a client that opted in', async () => {
      const { auth, user, ctx } = await setup();
      const { asset } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { memory } = await ctx.newMemory({ ownerId: user.id });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });

      await expect(ctx.syncStream(auth, [SyncRequestType.MemoryToAssetsV1], false, true)).resolves.toEqual([
        expect.objectContaining({
          type: SyncEntityType.MemoryToAssetV1,
          data: { memoryId: memory.id, assetId: asset.id },
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
    });
  });
});
