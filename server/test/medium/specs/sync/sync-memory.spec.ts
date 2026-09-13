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

describe(SyncEntityType.MemoryV1, () => {
  it('should detect and sync the first memory with the right properties', async () => {
    const { auth, user: user1, ctx } = await setup();
    const { memory } = await ctx.newMemory({ ownerId: user1.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.MemoriesV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          id: memory.id,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          deletedAt: memory.deletedAt,
          type: memory.type,
          data: memory.data,
          hideAt: memory.hideAt,
          showAt: memory.showAt,
          seenAt: memory.seenAt,
          memoryAt: expect.any(String),
          isSaved: memory.isSaved,
          ownerId: memory.ownerId,
        },
        type: 'MemoryV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.MemoriesV1]);
  });

  it('should detect and sync a deleted memory', async () => {
    const { auth, user, ctx } = await setup();
    const memoryRepo = ctx.get(MemoryRepository);
    const { memory } = await ctx.newMemory({ ownerId: user.id });
    await memoryRepo.delete(memory.id);

    const response = await ctx.syncStream(auth, [SyncRequestType.MemoriesV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          memoryId: memory.id,
        },
        type: 'MemoryDeleteV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.MemoriesV1]);
  });

  it('should sync a memory and then an update to that same memory', async () => {
    const { auth, user, ctx } = await setup();
    const memoryRepo = ctx.get(MemoryRepository);
    const { memory } = await ctx.newMemory({ ownerId: user.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.MemoriesV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({ id: memory.id }),
        type: 'MemoryV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await memoryRepo.update(memory.id, { seenAt: new Date() }, { privateMode: true, userId: user.id });
    const newResponse = await ctx.syncStream(auth, [SyncRequestType.MemoriesV1]);
    expect(newResponse).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({ id: memory.id }),
        type: 'MemoryV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, newResponse);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.MemoriesV1]);
  });

  it('should not sync a memory or a memory delete for an unrelated user', async () => {
    const { auth, ctx } = await setup();
    const memoryRepo = ctx.get(MemoryRepository);
    const { user: user2 } = await ctx.newUser();
    const { memory } = await ctx.newMemory({ ownerId: user2.id });

    await ctx.assertSyncIsComplete(auth, [SyncRequestType.MemoriesV1]);
    await memoryRepo.delete(memory.id);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.MemoriesV1]);
  });
  describe('private assets and the includePrivate flag', () => {
    it('should keep sending a memory that holds no private asset', async () => {
      const { auth, user, ctx } = await setup();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { memory } = await ctx.newMemory({ ownerId: user.id });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });

      await expect(ctx.syncStream(auth, [SyncRequestType.MemoriesV1])).resolves.toEqual([
        expect.objectContaining({ type: SyncEntityType.MemoryV1, data: expect.objectContaining({ id: memory.id }) }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
    });

    it('should replace a memory with a delete once it holds a private asset, and send it again once the asset is public', async () => {
      const { auth, user, ctx } = await setup();
      const assetRepo = ctx.get(AssetRepository);
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { memory } = await ctx.newMemory({ ownerId: user.id });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });
      await ctx.syncAckAll(auth, await ctx.syncStream(auth, [SyncRequestType.MemoriesV1]));

      await assetRepo.updateAll([asset.id], { isPrivate: true });
      await assetRepo.touchPrivateRelations([asset.id]);
      const hidden = await ctx.syncStream(auth, [SyncRequestType.MemoriesV1]);
      expect(hidden).toEqual([
        {
          ack: expect.stringContaining(SyncEntityType.MemoryDeleteV1),
          data: { memoryId: memory.id },
          type: SyncEntityType.MemoryDeleteV1,
        },
        expect.objectContaining({
          type: SyncEntityType.SyncAckV1,
          ack: expect.stringContaining(SyncEntityType.MemoryV1),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, hidden);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.MemoriesV1]);

      await assetRepo.updateAll([asset.id], { isPrivate: false });
      await assetRepo.touchPrivateRelations([asset.id]);
      const restored = await ctx.syncStream(auth, [SyncRequestType.MemoriesV1]);
      expect(restored).toEqual([
        expect.objectContaining({ type: SyncEntityType.MemoryV1, data: expect.objectContaining({ id: memory.id }) }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, restored);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.MemoriesV1]);
    });

    it('should never send a memory holding a private asset to a client that did not opt in', async () => {
      const { auth, user, ctx } = await setup();
      const { asset } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { memory } = await ctx.newMemory({ ownerId: user.id });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });

      const response = await ctx.syncStream(auth, [SyncRequestType.MemoriesV1]);
      expect(response.map(({ type }) => type)).not.toContain(SyncEntityType.MemoryV1);
      await ctx.syncAckAll(auth, response);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.MemoriesV1]);
    });

    it('should carry a memory holding a private asset for a client that opted in', async () => {
      const { auth, user, ctx } = await setup();
      const { asset } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { memory } = await ctx.newMemory({ ownerId: user.id });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });

      await expect(ctx.syncStream(auth, [SyncRequestType.MemoriesV1], false, true)).resolves.toEqual([
        expect.objectContaining({ type: SyncEntityType.MemoryV1, data: expect.objectContaining({ id: memory.id }) }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
    });
  });
});
