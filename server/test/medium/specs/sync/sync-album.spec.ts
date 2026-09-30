import { Kysely } from 'kysely';
import { AlbumUserRole, SyncEntityType, SyncRequestType } from 'src/enum';
import { AlbumUserRepository } from 'src/repositories/album-user.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
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

describe(SyncRequestType.AlbumsV1, () => {
  it('should sync an album with the correct properties', async () => {
    const { auth, ctx } = await setup();
    const { album } = await ctx.newAlbum({ ownerId: auth.user.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({
          id: album.id,
          name: album.albumName,
        }),
        type: SyncEntityType.AlbumV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
  });

  it('should detect and sync a new album', async () => {
    const { auth, ctx } = await setup();
    const { album } = await ctx.newAlbum({ ownerId: auth.user.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({
          id: album.id,
        }),
        type: SyncEntityType.AlbumV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
  });

  it('should detect and sync an album delete', async () => {
    const { auth, ctx } = await setup();
    const albumRepo = ctx.get(AlbumRepository);
    const { album } = await ctx.newAlbum({ ownerId: auth.user.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({
          id: album.id,
        }),
        type: SyncEntityType.AlbumV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await albumRepo.delete(album.id);

    const newResponse = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
    expect(newResponse).toEqual([
      {
        ack: expect.any(String),
        data: {
          albumId: album.id,
        },
        type: SyncEntityType.AlbumDeleteV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, newResponse);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
  });

  describe('shared albums', () => {
    it('should detect and sync an album create', async () => {
      const { auth, ctx } = await setup();
      const { user: user2 } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user2.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id, role: AlbumUserRole.Editor });

      const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(response).toEqual([
        {
          ack: expect.any(String),
          data: expect.objectContaining({ id: album.id }),
          type: SyncEntityType.AlbumV1,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, response);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
    });

    it('should detect and sync an album share (share before sync)', async () => {
      const { auth, ctx } = await setup();
      const { user: user2 } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user2.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id, role: AlbumUserRole.Editor });

      const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(response).toEqual([
        {
          ack: expect.any(String),
          data: expect.objectContaining({ id: album.id }),
          type: SyncEntityType.AlbumV1,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, response);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
    });

    it('should detect and sync an album share (share after sync)', async () => {
      const { auth, ctx } = await setup();
      const { user: user2 } = await ctx.newUser();
      const { album: userAlbum } = await ctx.newAlbum({ ownerId: auth.user.id });
      const { album: user2Album } = await ctx.newAlbum({ ownerId: user2.id });

      const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(response).toEqual([
        {
          ack: expect.any(String),
          data: expect.objectContaining({ id: userAlbum.id }),
          type: SyncEntityType.AlbumV1,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, response);
      await ctx.newAlbumUser({ userId: auth.user.id, albumId: user2Album.id, role: AlbumUserRole.Editor });

      const newResponse = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(newResponse).toEqual([
        {
          ack: expect.any(String),
          data: expect.objectContaining({ id: user2Album.id }),
          type: SyncEntityType.AlbumV1,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, newResponse);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
    });

    it('should detect and sync an album delete`', async () => {
      const { auth, ctx } = await setup();
      const albumRepo = ctx.get(AlbumRepository);
      const { user: user2 } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user2.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id, role: AlbumUserRole.Editor });

      const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(response).toEqual([
        expect.objectContaining({ type: SyncEntityType.AlbumV1 }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, response);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);

      await albumRepo.delete(album.id);
      const newResponse = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(newResponse).toEqual([
        {
          ack: expect.any(String),
          data: { albumId: album.id },
          type: SyncEntityType.AlbumDeleteV1,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, newResponse);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
    });

    it('should detect and sync an album unshare as an album delete', async () => {
      const { auth, ctx } = await setup();
      const albumUserRepo = ctx.get(AlbumUserRepository);
      const { user: user2 } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user2.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id, role: AlbumUserRole.Editor });

      const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(response).toEqual([
        expect.objectContaining({ type: SyncEntityType.AlbumV1 }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, response);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);

      await albumUserRepo.delete({ albumId: album.id, userId: auth.user.id });
      const newResponse = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(newResponse).toEqual([
        {
          ack: expect.any(String),
          data: { albumId: album.id },
          type: SyncEntityType.AlbumDeleteV1,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, newResponse);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
    });
  });
});

describe(SyncRequestType.AlbumsV2, () => {
  it('should carry the private flag and emit an upsert whenever the derived flag flips', async () => {
    // a client that opted in keeps receiving the album as an upsert, with the flag the triggers derive
    const { auth, ctx } = await setup();
    const { album } = await ctx.newAlbum({ ownerId: auth.user.id });
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id, isPrivate: true });

    const initial = await ctx.syncStream(auth, [SyncRequestType.AlbumsV2], false, true);
    expect(initial).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({ id: album.id, isPrivate: false }),
        type: SyncEntityType.AlbumV2,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.syncAckAll(auth, initial);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV2]);

    await ctx.get(AlbumRepository).addAssetIds(album.id, [asset.id]);
    const flipped = await ctx.syncStream(auth, [SyncRequestType.AlbumsV2], false, true);
    expect(flipped).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({ id: album.id, isPrivate: true }),
        type: SyncEntityType.AlbumV2,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.syncAckAll(auth, flipped);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV2]);

    await ctx.get(AssetRepository).update({ id: asset.id, isPrivate: false });
    const cleared = await ctx.syncStream(auth, [SyncRequestType.AlbumsV2], false, true);
    expect(cleared).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({ id: album.id, isPrivate: false }),
        type: SyncEntityType.AlbumV2,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });

  describe('private albums and the includePrivate flag', () => {
    it('should never send an album that was created private to a client that did not opt in', async () => {
      const { auth, ctx } = await setup();
      await ctx.newAlbum({ ownerId: auth.user.id, isPrivate: true });

      const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV2]);
      expect(response.map(({ type }) => type)).not.toContain(SyncEntityType.AlbumV2);

      await ctx.syncAckAll(auth, response);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV2]);
    });

    it('should carry a private album for a client that opted in', async () => {
      const { auth, ctx } = await setup();
      const { album } = await ctx.newAlbum({ ownerId: auth.user.id, isPrivate: true });

      await expect(ctx.syncStream(auth, [SyncRequestType.AlbumsV2], false, true)).resolves.toEqual([
        expect.objectContaining({
          type: SyncEntityType.AlbumV2,
          data: expect.objectContaining({ id: album.id, isPrivate: true }),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
    });

    it('should replace an album with a delete when it turns private, and send it again once it is public', async () => {
      const { auth, ctx } = await setup();
      const assetRepo = ctx.get(AssetRepository);
      const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
      const { album } = await ctx.newAlbum({ ownerId: auth.user.id }, [asset.id]);

      const initial = await ctx.syncStream(auth, [SyncRequestType.AlbumsV2]);
      expect(initial).toEqual([
        expect.objectContaining({
          type: SyncEntityType.AlbumV2,
          data: expect.objectContaining({ id: album.id, isPrivate: false }),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, initial);

      // the trigger marks the album private along with its asset
      await assetRepo.updateAll([asset.id], { isPrivate: true });
      await assetRepo.touchPrivateRelations([asset.id]);
      const hidden = await ctx.syncStream(auth, [SyncRequestType.AlbumsV2]);
      expect(hidden).toEqual([
        {
          ack: expect.stringContaining(SyncEntityType.AlbumDeleteV1),
          data: { albumId: album.id },
          type: SyncEntityType.AlbumDeleteV1,
        },
        expect.objectContaining({
          type: SyncEntityType.SyncAckV1,
          ack: expect.stringContaining(SyncEntityType.AlbumV2),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, hidden);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV2]);

      await assetRepo.updateAll([asset.id], { isPrivate: false });
      await assetRepo.touchPrivateRelations([asset.id]);
      const restored = await ctx.syncStream(auth, [SyncRequestType.AlbumsV2]);
      expect(restored).toEqual([
        expect.objectContaining({
          type: SyncEntityType.AlbumV2,
          data: expect.objectContaining({ id: album.id, isPrivate: false }),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, restored);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV2]);
    });

    it('should replace a private album with a delete on the deprecated AlbumsV1 stream as well', async () => {
      const { auth, ctx } = await setup();
      const assetRepo = ctx.get(AssetRepository);
      const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
      const { album } = await ctx.newAlbum({ ownerId: auth.user.id }, [asset.id]);
      await ctx.syncAckAll(auth, await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]));

      await assetRepo.updateAll([asset.id], { isPrivate: true });
      const hidden = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(hidden).toEqual([
        expect.objectContaining({ type: SyncEntityType.AlbumDeleteV1, data: { albumId: album.id } }),
        expect.objectContaining({
          type: SyncEntityType.SyncAckV1,
          ack: expect.stringContaining(SyncEntityType.AlbumV1),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, hidden);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
    });
  });
});
