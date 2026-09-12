import { Kysely } from 'kysely';
import { AlbumUserRole } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AlbumUserRepository } from 'src/repositories/album-user.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { MapRepository } from 'src/repositories/map.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { DB } from 'src/schema';
import { AlbumService } from 'src/services/album.service';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(AlbumService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AlbumRepository, AlbumUserRepository, AssetRepository, MapRepository, UserRepository],
    mock: [EventRepository, LoggingRepository],
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  return { sut, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AlbumService.name, () => {
  describe('removeAssets', () => {
    it('should not remove assets from an album of another user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);

      await expect(sut.removeAssets(factory.auth({ user: otherUser }), album.id, { ids: [asset.id] })).rejects.toThrow(
        'Not found or no albumAsset.delete access',
      );
      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.toContain(asset.id);
    });
  });

  describe('database triggers', () => {
    it('should cascade delete an album when the owner is deleted', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      await ctx.get(UserRepository).delete({ id: user.id }, true);

      await expect(ctx.database.selectFrom('album').selectAll().where('id', '=', album.id).execute()).resolves.toEqual(
        [],
      );
      await expect(
        ctx.database.selectFrom('album_user').selectAll().where('albumId', '=', album.id).execute(),
      ).resolves.toEqual([]);
    });
  });

  describe('private mode', () => {
    it('should hide private assets from the album asset list, count and dates outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id, localDateTime: '2021-01-01T00:00:00.000Z' });
      const { asset: hidden } = await ctx.newAsset({
        ownerId: user.id,
        isPrivate: true,
        localDateTime: '2023-01-01T00:00:00.000Z',
      });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [plain.id, hidden.id]);

      await expect(sut.get(factory.auth({ user }), album.id)).resolves.toMatchObject({
        assetCount: 1,
        startDate: '2021-01-01T00:00:00+00:00',
        endDate: '2021-01-01T00:00:00+00:00',
        isPrivate: true,
      });
      const [listed] = await sut.getAll(factory.auth({ user }), {});
      expect(listed).toMatchObject({ id: album.id, assetCount: 1, isPrivate: true });

      await expect(sut.get(factory.auth({ user, session: { privateMode: true } }), album.id)).resolves.toMatchObject({
        assetCount: 2,
        startDate: '2021-01-01T00:00:00+00:00',
        endDate: '2023-01-01T00:00:00+00:00',
      });
      const updated = await sut.update(factory.auth({ user, session: { privateMode: true } }), album.id, {
        albumName: 'renamed',
      });
      expect(updated.assetCount).toBe(2);
    });

    it('should show the owner private assets to a co-viewer only while their own session is in private mode', async () => {
      const { sut, ctx } = setup();
      const { album, owner, sharedWith } = await ctx.newSharedAlbum();
      const { asset: hidden } = await ctx.newAsset({ ownerId: owner.id, isPrivate: true });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: hidden.id });

      const off = await sut.get(factory.auth({ user: sharedWith }), album.id);
      expect(off.assetCount).toBe(1);
      expect(off.contributorCounts).toEqual([expect.objectContaining({ userId: owner.id })]);
      expect(Number(off.contributorCounts![0].assetCount)).toBe(1);

      const on = await sut.get(factory.auth({ user: sharedWith, session: { privateMode: true } }), album.id);
      expect(on.assetCount).toBe(2);
      expect(Number(on.contributorCounts![0].assetCount)).toBe(2);

      // the owner's own session decides for the owner too
      await expect(sut.get(factory.auth({ user: owner }), album.id)).resolves.toMatchObject({ assetCount: 1 });
    });

    it('should hide a private cover outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { album } = await ctx.newAlbum({ ownerId: user.id, albumThumbnailAssetId: hidden.id }, [hidden.id]);

      await expect(sut.get(factory.auth({ user }), album.id)).resolves.toMatchObject({ albumThumbnailAssetId: null });
      const [listed] = await sut.getAll(factory.auth({ user }), {});
      expect(listed.albumThumbnailAssetId).toBeNull();

      await expect(sut.get(factory.auth({ user, session: { privateMode: true } }), album.id)).resolves.toMatchObject({
        albumThumbnailAssetId: hidden.id,
      });
    });

    it('should prefer a non-private asset when picking a cover', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: '2020-01-01T00:00:00.000Z' });
      const { asset: hidden } = await ctx.newAsset({
        ownerId: user.id,
        isPrivate: true,
        fileCreatedAt: '2024-01-01T00:00:00.000Z',
      });
      const { album } = await ctx.newAlbum({ ownerId: user.id, albumThumbnailAssetId: null }, [plain.id, hidden.id]);

      const [listed] = await sut.getAll(factory.auth({ user, session: { privateMode: true } }), {});
      expect(listed).toMatchObject({ id: album.id, albumThumbnailAssetId: plain.id });
    });

    it('should hide private assets from the album map markers outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      await ctx.newExif({ assetId: plain.id, latitude: 1, longitude: 1 });
      await ctx.newExif({ assetId: hidden.id, latitude: 2, longitude: 2 });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [plain.id, hidden.id]);

      await expect(sut.getMapMarkers(factory.auth({ user }), album.id)).resolves.toEqual([
        expect.objectContaining({ id: plain.id }),
      ]);
      await expect(
        sut.getMapMarkers(factory.auth({ user, session: { privateMode: true } }), album.id),
      ).resolves.toHaveLength(2);
    });

    it('should not let an editor add assets to a private album outside private mode', async () => {
      const { sut, ctx } = setup();
      const { album, owner, sharedWith } = await ctx.newSharedAlbum();
      const { asset: hidden } = await ctx.newAsset({ ownerId: owner.id, isPrivate: true });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: hidden.id });
      const { asset: theirs } = await ctx.newAsset({ ownerId: sharedWith.id });
      const { asset: theirsToo } = await ctx.newAsset({ ownerId: sharedWith.id });

      await expect(sut.addAssets(factory.auth({ user: sharedWith }), album.id, { ids: [theirs.id] })).rejects.toThrow(
        'Private mode is required',
      );
      await expect(
        sut.addAssetsToAlbums(factory.auth({ user: sharedWith }), { albumIds: [album.id], assetIds: [theirsToo.id] }),
      ).rejects.toThrow('Private mode is required');

      await expect(
        sut.addAssets(factory.auth({ user: sharedWith, session: { privateMode: true } }), album.id, {
          ids: [theirs.id],
        }),
      ).resolves.toEqual([{ id: theirs.id, success: true }]);
      // the trigger made the new asset private
      await expect(
        ctx.database.selectFrom('asset').select('isPrivate').where('id', '=', theirs.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ isPrivate: true });
    });

    it('should require confirmPrivate to share a private album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [hidden.id]);
      const auth = factory.auth({ user, session: { privateMode: true } });
      const albumUsers = [{ userId: other.id, role: AlbumUserRole.Editor }];

      await expect(sut.addUsers(auth, album.id, { albumUsers })).rejects.toThrow(
        'Album contains private assets, confirmPrivate is required',
      );
      await expect(sut.addUsers(auth, album.id, { albumUsers, confirmPrivate: true })).resolves.toMatchObject({
        isPrivate: true,
        albumUsers: [
          expect.objectContaining({ role: AlbumUserRole.Owner }),
          expect.objectContaining({ role: AlbumUserRole.Editor }),
        ],
      });
    });
  });

  describe('private mode triggers', () => {
    it('should mark the album private when a private asset is added and clear it when the last one is removed', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [plain.id]);
      const albumRepo = ctx.get(AlbumRepository);
      const getAlbum = () =>
        ctx.database
          .selectFrom('album')
          .select(['isPrivate', 'updateId'])
          .where('id', '=', album.id)
          .executeTakeFirstOrThrow();

      const before = await getAlbum();
      expect(before.isPrivate).toBe(false);

      await albumRepo.addAssetIds(album.id, [hidden.id]);
      const flipped = await getAlbum();
      expect(flipped.isPrivate).toBe(true);
      expect(flipped.updateId).not.toBe(before.updateId);

      await albumRepo.removeAssetIds(album.id, [hidden.id]);
      const cleared = await getAlbum();
      expect(cleared.isPrivate).toBe(false);
      expect(cleared.updateId).not.toBe(flipped.updateId);
    });

    it('should make an asset private when it is added to a private album', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [hidden.id]);

      await ctx.get(AlbumRepository).addAssetIds(album.id, [plain.id]);

      await expect(
        ctx.database.selectFrom('asset').select('isPrivate').where('id', '=', plain.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ isPrivate: true });
    });

    it('should clear the album flag when its only private asset is unmarked or trashed, and set it again on restore', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [hidden.id]);
      const assetRepo = ctx.get(AssetRepository);
      const isAlbumPrivate = async () => {
        const row = await ctx.database
          .selectFrom('album')
          .select('isPrivate')
          .where('id', '=', album.id)
          .executeTakeFirstOrThrow();
        return row.isPrivate;
      };

      await expect(isAlbumPrivate()).resolves.toBe(true);

      await assetRepo.update({ id: hidden.id, isPrivate: false });
      await expect(isAlbumPrivate()).resolves.toBe(false);

      await assetRepo.update({ id: hidden.id, isPrivate: true });
      await expect(isAlbumPrivate()).resolves.toBe(true);

      await ctx.softDeleteAsset(hidden.id);
      await expect(isAlbumPrivate()).resolves.toBe(false);

      await ctx.database.updateTable('asset').set({ deletedAt: null }).where('id', '=', hidden.id).execute();
      await expect(isAlbumPrivate()).resolves.toBe(true);
    });
  });
});
