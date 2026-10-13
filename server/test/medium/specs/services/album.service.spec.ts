import { Kysely } from 'kysely';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto';
import { AlbumUserRole, SharedLinkType } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AlbumUserRepository } from 'src/repositories/album-user.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { MapRepository } from 'src/repositories/map.repository';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { DB } from 'src/schema';
import { AlbumService } from 'src/services/album.service';
import { newMediumService } from 'test/medium.factory';
import { factory, newUuid } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(AlbumService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AlbumRepository,
      AlbumUserRepository,
      AssetRepository,
      MapRepository,
      SharedLinkRepository,
      UserRepository,
    ],
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
    it('should hide a private album as a whole from the owner outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id, localDateTime: '2021-01-01T00:00:00.000Z' });
      const { asset: hidden } = await ctx.newAsset({
        ownerId: user.id,
        isPrivate: true,
        localDateTime: '2023-01-01T00:00:00.000Z',
      });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [plain.id, hidden.id]);
      const { album: plainAlbum } = await ctx.newAlbum({ ownerId: user.id }, [plain.id]);

      const off = factory.auth({ user });
      await expect(sut.get(off, album.id)).rejects.toThrow('Not found or no album.read access');
      await expect(sut.getAll(off, {})).resolves.toEqual([expect.objectContaining({ id: plainAlbum.id })]);
      await expect(sut.getAll(off, { assetId: plain.id })).resolves.toEqual([
        expect.objectContaining({ id: plainAlbum.id }),
      ]);
      await expect(sut.getStatistics(off)).resolves.toEqual({ owned: 1, shared: 0, notShared: 1 });

      const on = factory.auth({ user, session: { privateMode: true } });
      const fullView = await sut.get(on, album.id);
      expect(fullView).toMatchObject({ assetCount: 2, isPrivate: true });
      expect(new Date(fullView.startDate!).toISOString()).toBe('2021-01-01T00:00:00.000Z');
      expect(new Date(fullView.endDate!).toISOString()).toBe('2023-01-01T00:00:00.000Z');
      const listed = await sut.getAll(on, {});
      expect(listed.map(({ id }) => id).sort()).toEqual([album.id, plainAlbum.id].sort());
      const byAsset = await sut.getAll(on, { assetId: plain.id });
      expect(byAsset.map(({ id }) => id).sort()).toEqual([album.id, plainAlbum.id].sort());
      await expect(sut.getStatistics(on)).resolves.toEqual({ owned: 2, shared: 0, notShared: 2 });
    });

    it('should hide a private album from a co-viewer until their own session is in private mode', async () => {
      const { sut, ctx } = setup();
      const { album, owner, sharedWith } = await ctx.newSharedAlbum();
      const { asset: hidden } = await ctx.newAsset({ ownerId: owner.id, isPrivate: true });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: hidden.id });

      const off = factory.auth({ user: sharedWith });
      await expect(sut.get(off, album.id)).rejects.toThrow('Not found or no album.read access');
      await expect(sut.getAll(off, {})).resolves.toEqual([]);
      await expect(sut.getStatistics(off)).resolves.toEqual({ owned: 0, shared: 0, notShared: 0 });

      const on = factory.auth({ user: sharedWith, session: { privateMode: true } });
      const view = await sut.get(on, album.id);
      expect(view.assetCount).toBe(2);
      expect(view.contributorCounts).toEqual([expect.objectContaining({ userId: owner.id })]);
      expect(Number(view.contributorCounts![0].assetCount)).toBe(2);
      await expect(sut.getAll(on, {})).resolves.toEqual([expect.objectContaining({ id: album.id, assetCount: 2 })]);
      await expect(sut.getStatistics(on)).resolves.toEqual({ owned: 0, shared: 1, notShared: 0 });

      // the owner's own session decides for the owner too
      await expect(sut.get(factory.auth({ user: owner }), album.id)).rejects.toThrow(
        'Not found or no album.read access',
      );
    });

    it('should refuse to update, delete, share or change the assets of a hidden private album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [hidden.id]);
      const albumUsers = [{ userId: other.id, role: AlbumUserRole.Editor }];

      const off = factory.auth({ user });
      await expect(sut.update(off, album.id, { albumName: 'renamed' })).rejects.toThrow(
        'Not found or no album.update access',
      );
      await expect(sut.delete(off, album.id)).rejects.toThrow('Not found or no album.delete access');
      await expect(sut.addAssets(off, album.id, { ids: [plain.id] })).rejects.toThrow(
        'Not found or no albumAsset.create access',
      );
      await expect(sut.addAssetsToAlbums(off, { albumIds: [album.id], assetIds: [plain.id] })).resolves.toEqual({
        success: false,
        error: BulkIdErrorReason.NO_PERMISSION,
      });
      await expect(sut.removeAssets(off, album.id, { ids: [hidden.id] })).rejects.toThrow(
        'Not found or no albumAsset.delete access',
      );
      await expect(sut.addUsers(off, album.id, { albumUsers, confirmPrivate: true })).rejects.toThrow(
        'Not found or no album.share access',
      );
      await expect(sut.getMapMarkers(off, album.id)).rejects.toThrow('Not found or no album.read access');
      await expect(ctx.get(AlbumRepository).getById(album.id, { withAssets: false })).resolves.toMatchObject({
        albumName: album.albumName,
      });

      const on = factory.auth({ user, session: { privateMode: true } });
      await expect(sut.update(on, album.id, { albumName: 'renamed' })).resolves.toMatchObject({
        albumName: 'renamed',
        assetCount: 1,
      });
      await expect(sut.addAssets(on, album.id, { ids: [plain.id] })).resolves.toEqual([
        { id: plain.id, success: true },
      ]);
      await expect(sut.removeAssets(on, album.id, { ids: [plain.id] })).resolves.toEqual([
        { id: plain.id, success: true },
      ]);
      await expect(sut.addUsers(on, album.id, { albumUsers, confirmPrivate: true })).resolves.toMatchObject({
        albumUsers: [
          expect.objectContaining({ role: AlbumUserRole.Owner }),
          expect.objectContaining({ role: AlbumUserRole.Editor }),
        ],
      });
      await sut.delete(on, album.id);
      await expect(ctx.get(AlbumRepository).getById(album.id, { withAssets: false })).resolves.toBeUndefined();
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

    it('should serve the album map markers only in private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      await ctx.newExif({ assetId: plain.id, latitude: 1, longitude: 1 });
      await ctx.newExif({ assetId: hidden.id, latitude: 2, longitude: 2 });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [plain.id, hidden.id]);

      await expect(sut.getMapMarkers(factory.auth({ user }), album.id)).rejects.toThrow(
        'Not found or no album.read access',
      );
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
        'Not found or no albumAsset.create access',
      );
      await expect(
        sut.addAssetsToAlbums(factory.auth({ user: sharedWith }), { albumIds: [album.id], assetIds: [theirsToo.id] }),
      ).resolves.toEqual({ success: false, error: BulkIdErrorReason.NO_PERMISSION });

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

    it('should require confirmPrivate to create an album with other users and private assets', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const auth = factory.auth({ user, session: { privateMode: true } });
      const albumUsers = [{ userId: other.id, role: AlbumUserRole.Editor }];

      await expect(sut.create(auth, { albumName: 'shared', albumUsers, assetIds: [hidden.id] })).rejects.toThrow(
        'Album contains private assets, confirmPrivate is required',
      );
      await expect(sut.getAll(auth, {})).resolves.toEqual([]);

      // nothing is shared without other users, so no confirmation is needed
      await expect(sut.create(auth, { albumName: 'mine', assetIds: [hidden.id] })).resolves.toMatchObject({
        isPrivate: true,
      });

      const created = await sut.create(auth, {
        albumName: 'shared',
        albumUsers,
        assetIds: [hidden.id],
        confirmPrivate: true,
      });
      expect(created).toMatchObject({
        isPrivate: true,
        albumUsers: [
          expect.objectContaining({ role: AlbumUserRole.Owner }),
          expect.objectContaining({ role: AlbumUserRole.Editor }),
        ],
      });
      await expect(
        sut.get(factory.auth({ user: other, session: { privateMode: true } }), created.id),
      ).resolves.toMatchObject({
        assetCount: 1,
      });
    });

    it('should require confirmPrivate to add private assets to an album shared with other users', async () => {
      const { sut, ctx } = setup();
      const { album, owner } = await ctx.newSharedAlbum();
      const { asset: plain } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: hidden } = await ctx.newAsset({ ownerId: owner.id, isPrivate: true });
      const auth = factory.auth({ user: owner, session: { privateMode: true } });

      await expect(sut.addAssets(auth, album.id, { ids: [plain.id, hidden.id] })).rejects.toThrow(
        'Album contains private assets, confirmPrivate is required',
      );
      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [plain.id, hidden.id])).resolves.toEqual(new Set());

      // plain assets never need a confirmation
      await expect(sut.addAssets(auth, album.id, { ids: [plain.id] })).resolves.toEqual([
        { id: plain.id, success: true },
      ]);
      await expect(sut.addAssets(auth, album.id, { ids: [hidden.id], confirmPrivate: true })).resolves.toEqual([
        { id: hidden.id, success: true },
      ]);
      await expect(sut.get(auth, album.id)).resolves.toMatchObject({ isPrivate: true, assetCount: 3 });
    });

    it('should require confirmPrivate to add private assets to an album behind a shared link', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [plain.id]);
      await ctx.get(SharedLinkRepository).create({
        allowUpload: false,
        key: Buffer.from(newUuid()),
        type: SharedLinkType.Album,
        userId: user.id,
        albumId: album.id,
      });
      const auth = factory.auth({ user, session: { privateMode: true } });

      await expect(sut.addAssets(auth, album.id, { ids: [hidden.id] })).rejects.toThrow(
        'Album contains private assets, confirmPrivate is required',
      );
      await expect(sut.addAssets(auth, album.id, { ids: [hidden.id], confirmPrivate: true })).resolves.toEqual([
        { id: hidden.id, success: true },
      ]);
    });

    it('should require confirmPrivate to add private assets to shared albums in bulk', async () => {
      const { sut, ctx } = setup();
      const { album, owner } = await ctx.newSharedAlbum();
      const { album: mine } = await ctx.newAlbum({ ownerId: owner.id });
      const { asset: hidden } = await ctx.newAsset({ ownerId: owner.id, isPrivate: true });
      const auth = factory.auth({ user: owner, session: { privateMode: true } });

      // an album that is not shared needs no confirmation
      await expect(sut.addAssetsToAlbums(auth, { albumIds: [mine.id], assetIds: [hidden.id] })).resolves.toEqual({
        success: true,
      });

      await expect(sut.addAssetsToAlbums(auth, { albumIds: [album.id], assetIds: [hidden.id] })).rejects.toThrow(
        'Album contains private assets, confirmPrivate is required',
      );
      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [hidden.id])).resolves.toEqual(new Set());

      await expect(
        sut.addAssetsToAlbums(auth, { albumIds: [album.id], assetIds: [hidden.id], confirmPrivate: true }),
      ).resolves.toEqual({ success: true });
      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [hidden.id])).resolves.toEqual(new Set([hidden.id]));
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
