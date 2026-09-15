import { Kysely } from 'kysely';
import { SyncEntityType, SyncRequestType } from 'src/enum';
import { AssetRepository } from 'src/repositories/asset.repository';
import { DB } from 'src/schema';
import { SyncTestContext } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = async (db?: Kysely<DB>) => {
  const ctx = new SyncTestContext(db || defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  return { auth, user, session, ctx };
};

/** two stacked assets, one of them in an album, synced and acked once; then one member turns private */
const stackedInAlbum = async (includePrivate: boolean) => {
  const { auth, ctx } = await setup();
  const { asset: inAlbum } = await ctx.newAsset({ ownerId: auth.user.id });
  const { asset: loose } = await ctx.newAsset({ ownerId: auth.user.id });
  const { album } = await ctx.newAlbum({ ownerId: auth.user.id }, [inAlbum.id]);
  await ctx.newStack({ ownerId: auth.user.id }, [inAlbum.id, loose.id]);
  const types = [SyncRequestType.AssetsV2, SyncRequestType.AlbumsV2];
  await ctx.syncAckAll(auth, await ctx.syncStream(auth, types, false, includePrivate));
  await ctx.assertSyncIsComplete(auth, types);

  // the flag lands on the targeted asset first and on the rest of its stack afterwards, like the asset service does
  const assetRepo = ctx.get(AssetRepository);
  await assetRepo.updateAll([loose.id], { isPrivate: true });
  await assetRepo.updateAll([inAlbum.id], { isPrivate: true });
  await assetRepo.touchPrivateRelations([loose.id, inAlbum.id]);

  return { auth, ctx, inAlbum, loose, album, types };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(SyncEntityType.AssetV2, () => {
  it('should sync every member of a stack and the album holding one of them once another member turns private', async () => {
    const { auth, ctx, inAlbum, loose, album, types } = await stackedInAlbum(true);

    const response = await ctx.syncStream(auth, types, false, true);
    expect(response).toHaveLength(4);
    expect(response).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: SyncEntityType.AssetV2,
          data: expect.objectContaining({ id: loose.id, isPrivate: true }),
        }),
        expect.objectContaining({
          type: SyncEntityType.AssetV2,
          data: expect.objectContaining({ id: inAlbum.id, isPrivate: true }),
        }),
        expect.objectContaining({
          type: SyncEntityType.AlbumV2,
          data: expect.objectContaining({ id: album.id, isPrivate: true }),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]),
    );

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, types);
  });

  it('should replace every member of a stack and the album holding one of them with deletes for a client that did not opt in', async () => {
    const { auth, ctx, inAlbum, loose, album, types } = await stackedInAlbum(false);

    const response = await ctx.syncStream(auth, types);
    expect(response).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: SyncEntityType.AssetDeleteV1, data: { assetId: loose.id } }),
        expect.objectContaining({ type: SyncEntityType.AssetDeleteV1, data: { assetId: inAlbum.id } }),
        expect.objectContaining({ type: SyncEntityType.AlbumDeleteV1, data: { albumId: album.id } }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]),
    );
    expect(response.map(({ type }) => type)).not.toContain(SyncEntityType.AssetV2);
    expect(response.map(({ type }) => type)).not.toContain(SyncEntityType.AlbumV2);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, types);
  });

  it('should detect and sync the first asset', async () => {
    const originalFileName = 'firstAsset';
    const checksum = '1115vHcVkZzNp3Q9G+FEA0nu6zUbGb4Tj4UOXkN0wRA=';
    const thumbhash = '2225vHcVkZzNp3Q9G+FEA0nu6zUbGb4Tj4UOXkN0wRA=';
    const date = new Date().toISOString();

    const { auth, ctx } = await setup();
    const { asset } = await ctx.newAsset({
      originalFileName,
      ownerId: auth.user.id,
      checksum: Buffer.from(checksum, 'base64'),
      thumbhash: Buffer.from(thumbhash, 'base64'),
      fileCreatedAt: date,
      fileModifiedAt: date,
      localDateTime: date,
      createdAt: date,
      deletedAt: null,
      duration: 600_000,
      libraryId: null,
      width: 1920,
      height: 1080,
    });

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          id: asset.id,
          originalFileName,
          ownerId: asset.ownerId,
          thumbhash,
          checksum,
          deletedAt: asset.deletedAt,
          fileCreatedAt: asset.fileCreatedAt,
          fileModifiedAt: asset.fileModifiedAt,
          createdAt: asset.createdAt,
          isFavorite: asset.isFavorite,
          isPrivate: asset.isPrivate,
          localDateTime: asset.localDateTime,
          type: asset.type,
          visibility: asset.visibility,
          duration: asset.duration,
          stackId: null,
          livePhotoVideoId: null,
          libraryId: asset.libraryId,
          width: asset.width,
          height: asset.height,
          isEdited: asset.isEdited,
        },
        type: 'AssetV2',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
  });

  it('should detect and sync a deleted asset', async () => {
    const { auth, ctx } = await setup();
    const assetRepo = ctx.get(AssetRepository);
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
    await assetRepo.remove(asset);

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          assetId: asset.id,
        },
        type: 'AssetDeleteV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
  });

  it('should not sync an asset or asset delete for an unrelated user', async () => {
    const { auth, ctx } = await setup();
    const assetRepo = ctx.get(AssetRepository);
    const { user: user2 } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user2.id });
    const { asset } = await ctx.newAsset({ ownerId: user2.id });
    const auth2 = factory.auth({ session, user: user2 });

    expect(await ctx.syncStream(auth2, [SyncRequestType.AssetsV2])).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetV2 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);

    await assetRepo.remove(asset);
    expect(await ctx.syncStream(auth2, [SyncRequestType.AssetsV2])).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetDeleteV1 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
  });

  it('should carry the private flag', async () => {
    const { auth, ctx } = await setup();
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id, isPrivate: true });

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV2], false, true);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({ id: asset.id, isPrivate: true }),
        type: SyncEntityType.AssetV2,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });
  describe('private assets and the includePrivate flag', () => {
    it('should leave a private asset out of the stream for a client that did not opt in', async () => {
      const { auth, ctx } = await setup();
      await ctx.newAsset({ ownerId: auth.user.id, isPrivate: true });

      const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
      expect(response.map(({ type }) => type)).not.toContain(SyncEntityType.AssetV2);

      await ctx.syncAckAll(auth, response);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
    });

    it('should carry a private asset for a client that opted in', async () => {
      const { auth, ctx } = await setup();
      const { asset } = await ctx.newAsset({ ownerId: auth.user.id, isPrivate: true });

      await expect(ctx.syncStream(auth, [SyncRequestType.AssetsV2], false, true)).resolves.toEqual([
        expect.objectContaining({
          type: SyncEntityType.AssetV2,
          data: expect.objectContaining({ id: asset.id, isPrivate: true }),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
    });

    it('should send a delete when an asset becomes private, and the asset again when it becomes public', async () => {
      const { auth, ctx } = await setup();
      const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
      const assetRepo = ctx.get(AssetRepository);

      const initial = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
      expect(initial).toEqual([
        expect.objectContaining({ type: SyncEntityType.AssetV2, data: expect.objectContaining({ id: asset.id }) }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, initial);

      await assetRepo.updateAll([asset.id], { isPrivate: true });
      const hidden = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
      expect(hidden).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: SyncEntityType.AssetDeleteV1, data: { assetId: asset.id } }),
        ]),
      );
      expect(hidden.map(({ type }) => type)).not.toContain(SyncEntityType.AssetV2);
      await ctx.syncAckAll(auth, hidden);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);

      await assetRepo.updateAll([asset.id], { isPrivate: false });
      const restored = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
      expect(restored).toEqual([
        expect.objectContaining({
          type: SyncEntityType.AssetV2,
          data: expect.objectContaining({ id: asset.id, isPrivate: false }),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, restored);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
    });

    it('should keep sending a private asset as an upsert to a client that opted in when it changes', async () => {
      const { auth, ctx } = await setup();
      const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
      const assetRepo = ctx.get(AssetRepository);
      await ctx.syncAckAll(auth, await ctx.syncStream(auth, [SyncRequestType.AssetsV2], false, true));

      await assetRepo.updateAll([asset.id], { isPrivate: true });
      await expect(ctx.syncStream(auth, [SyncRequestType.AssetsV2], false, true)).resolves.toEqual([
        expect.objectContaining({
          type: SyncEntityType.AssetV2,
          data: expect.objectContaining({ id: asset.id, isPrivate: true }),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
    });
  });
});
