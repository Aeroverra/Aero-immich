import { UnauthorizedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { SearchSuggestionType } from 'src/dtos/search.dto';
import { AlbumUserRole, AssetOrder, AssetType, AssetVisibility, SearchOrderField } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PartnerRepository } from 'src/repositories/partner.repository';
import { PersonRepository } from 'src/repositories/person.repository';
import { SearchRepository } from 'src/repositories/search.repository';
import { DB } from 'src/schema';
import { SearchService } from 'src/services/search.service';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const unitVector = (index: number) => JSON.stringify(Array.from({ length: 512 }, (_, i) => (i === index ? 1 : 0)));

const setup = (db?: Kysely<DB>) => {
  return newMediumService(SearchService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AssetRepository,
      DatabaseRepository,
      SearchRepository,
      PartnerRepository,
      PersonRepository,
    ],
    mock: [LoggingRepository],
  });
};

const newPrivatePair = async (ctx: ReturnType<typeof setup>['ctx'], ownerId: string) => {
  const { asset: publicAsset } = await ctx.newAsset({ ownerId });
  await ctx.newExif({ assetId: publicAsset.id, fileSizeInByte: 100, make: 'Canon', city: 'Oslo' });
  const { asset: privateAsset } = await ctx.newAsset({ ownerId, isPrivate: true });
  await ctx.newExif({ assetId: privateAsset.id, fileSizeInByte: 200, make: 'Leica', city: 'Bergen' });
  return { publicAsset, privateAsset };
};

const ids = (items: { id: string }[]) => items.map(({ id }) => id).toSorted();

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(SearchService.name, () => {
  it('should work', () => {
    const { sut } = setup();
    expect(sut).toBeDefined();
  });

  it('should return assets', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();

    const assets = [];
    const sizes = [12_334, 599, 123_456];

    for (let i = 0; i < sizes.length; i++) {
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: sizes[i] });
      assets.push(asset);
    }

    const auth = factory.auth({ user: { id: user.id } });

    await expect(sut.searchLargeAssets(auth, { size: 250 })).resolves.toEqual([
      expect.objectContaining({ id: assets[2].id }),
      expect.objectContaining({ id: assets[0].id }),
      expect.objectContaining({ id: assets[1].id }),
    ]);
  });

  describe('searchStatistics', () => {
    it('should return statistics when filtering by personIds', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      const auth = factory.auth({ user: { id: user.id } });

      const result = await sut.searchStatistics(auth, { personIds: [person.personGroupId] });

      expect(result).toEqual({ total: 1 });
    });

    it('should return zero when no assets match the personIds filter', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });

      const auth = factory.auth({ user: { id: user.id } });

      const result = await sut.searchStatistics(auth, { personIds: [person.personGroupId] });

      expect(result).toEqual({ total: 0 });
    });

    it('should not return locked assets of partner in elevated session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();

      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });

      await ctx.newAsset({ ownerId: partner.id, visibility: AssetVisibility.Locked });

      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

      const result = await sut.searchStatistics(auth, { visibility: AssetVisibility.Locked });

      expect(result).toEqual({ total: 0 });
    });
  });

  describe('withStacked option', () => {
    it('should exclude stacked assets when withStacked is false', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      const { asset: primaryAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: stackedAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: unstackedAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newStack({ ownerId: user.id }, [primaryAsset.id, stackedAsset.id]);

      const auth = factory.auth({ user: { id: user.id } });

      const response = await sut.searchMetadata(auth, { size: 250, withStacked: false });

      expect(response.assets.items.length).toBe(1);
      expect(response.assets.items[0].id).toBe(unstackedAsset.id);
    });

    describe('visibility', () => {
      it('should filter out locked assets in a default session', async () => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();

        await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

        const auth = factory.auth({ user: { id: user.id } });

        const response = await sut.searchMetadata(auth, { size: 250, withStacked: false });

        expect(response.assets.items.length).toBe(0);
      });

      it('should return locked assets in an elevated session', async () => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();

        await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

        const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

        const response = await sut.searchMetadata(auth, { size: 250, withStacked: false });

        expect(response.assets.items.length).toBe(1);
      });
    });
  });

  describe('albumIds option', () => {
    it('should return assets from shared album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: otherUser.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: user.id, role: AlbumUserRole.Editor });

      const auth = factory.auth({ user: { id: user.id } });

      const response = await sut.searchMetadata(auth, { size: 250, albumIds: [album.id] });

      expect(response.assets.items.length).toBe(1);
    });

    it('should not return assets for album, a user is not in, when partner sharing is enabled', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();

      await ctx.newPartner({ sharedById: otherUser.id, sharedWithId: user.id });

      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: otherUser.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      const auth = factory.auth({ user: { id: user.id } });

      await expect(sut.searchMetadata(auth, { size: 250, albumIds: [album.id] })).rejects.toThrow(
        'Not found or no album.read access',
      );
    });
  });

  describe('getSearchSuggestions', () => {
    it('should filter out empty search suggestions', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      const { asset: assetWithEmptyMake } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: assetWithEmptyMake.id, make: '' });

      const auth = factory.auth({ user: { id: user.id } });
      const suggestions = await sut.getSearchSuggestions(auth, {
        type: SearchSuggestionType.CAMERA_MAKE,
        includeNull: true,
      });

      expect(suggestions).toEqual(['Canon', null]);
    });
  });

  describe('searchRandom', () => {
    it('should filter out locked assets in a default session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

      const auth = factory.auth({ user: { id: user.id } });

      const response = await sut.searchRandom(auth, { size: 250 });

      expect(response.length).toBe(0);
    });
  });

  describe('new search shape', () => {
    it('should filter by an exif field and return a cursor-less single page', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, city: 'Oslo' });
      const { asset: other } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: other.id, city: 'Bergen' });

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, { size: 250, filter: { city: { eq: 'Oslo' } } });

      expect(response.assets.items).toEqual([expect.objectContaining({ id: asset.id })]);
      expect(response.assets.nextPage).toBeNull();
      expect(response.assets.nextCursor).toBeNull();
    });

    it('should combine OR branches', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: oslo } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: oslo.id, city: 'Oslo' });
      const { asset: favorite } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
      await ctx.newAsset({ ownerId: user.id });

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        filter: { or: [{ city: { eq: 'Oslo' } }, { isFavorite: { eq: true } }] },
      });

      expect(response.assets.items.map(({ id }) => id).toSorted()).toEqual([oslo.id, favorite.id].toSorted());
    });

    it('should scope a top-level album constraint to the album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, { size: 250, filter: { albumIds: { any: [album.id] } } });

      expect(response.assets.items).toEqual([expect.objectContaining({ id: asset.id })]);
    });

    it('should scope an album-constrained branch to the album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        filter: { or: [{ albumIds: { any: [album.id] } }] },
      });

      expect(response.assets.items).toEqual([expect.objectContaining({ id: asset.id })]);
    });

    it('should keep the ownership scope for branches without an album constraint', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset: ownOslo } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: ownOslo.id, city: 'Oslo' });
      const { asset: foreignOslo } = await ctx.newAsset({ ownerId: otherUser.id });
      await ctx.newExif({ assetId: foreignOslo.id, city: 'Oslo' });
      const { asset: albumAsset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: albumAsset.id });

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        filter: { or: [{ albumIds: { any: [album.id] } }, { city: { eq: 'Oslo' } }] },
      });

      // the album branch searches the album, the city branch stays confined to the caller's own assets
      expect(response.assets.items.map(({ id }) => id).toSorted()).toEqual([ownOslo.id, albumAsset.id].toSorted());
    });

    it('should reject an inaccessible album anywhere in the filter', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: otherUser.id });

      const auth = factory.auth({ user: { id: user.id } });

      await expect(
        sut.searchMetadata(auth, { size: 250, filter: { or: [{ albumIds: { none: [album.id] } }] } }),
      ).rejects.toThrow('Not found or no album.read access');
    });

    it('should return locked assets only to an elevated session that asks for them', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: timeline } = await ctx.newAsset({ ownerId: user.id });
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

      const unelevated = await sut.searchMetadata(factory.auth({ user: { id: user.id } }), { size: 250, filter: {} });
      expect(unelevated.assets.items).toEqual([expect.objectContaining({ id: timeline.id })]);

      const elevatedAuth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
      const elevated = await sut.searchMetadata(elevatedAuth, {
        size: 250,
        filter: { visibility: { eq: AssetVisibility.Locked } },
      });
      expect(elevated.assets.items).toEqual([expect.objectContaining({ id: locked.id })]);
    });

    it('should exclude partner assets from a locked-only search', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });
      const { asset: ownLocked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      await ctx.newAsset({ ownerId: partner.id, visibility: AssetVisibility.Locked });

      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        filter: { visibility: { eq: AssetVisibility.Locked } },
      });

      expect(response.assets.items).toEqual([expect.objectContaining({ id: ownLocked.id })]);
    });

    it('should never return partner locked assets, even for locked-matching mixed filters', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });
      const { asset: ownLocked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { asset: partnerTimeline } = await ctx.newAsset({ ownerId: partner.id });
      await ctx.newAsset({ ownerId: partner.id, visibility: AssetVisibility.Locked });

      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        filter: { visibility: { in: [AssetVisibility.Locked, AssetVisibility.Timeline] } },
      });

      const ids = response.assets.items.map(({ id }) => id);
      expect(ids.toSorted()).toEqual([ownLocked.id, partnerTimeline.id].toSorted());
    });

    it('should paginate with an opaque cursor', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      for (let i = 0; i < 3; i++) {
        await ctx.newAsset({ ownerId: user.id });
      }

      const auth = factory.auth({ user: { id: user.id } });

      const firstPage = await sut.searchMetadata(auth, { filter: {}, size: 2 });
      expect(firstPage.assets.items.length).toBe(2);
      expect(firstPage.assets.nextPage).toBeNull();
      expect(firstPage.assets.nextCursor).toEqual(expect.any(String));

      const secondPage = await sut.searchMetadata(auth, { cursor: firstPage.assets.nextCursor!, size: 2 });
      expect(secondPage.assets.items.length).toBe(1);
      expect(secondPage.assets.nextCursor).toBeNull();

      const ids = [...firstPage.assets.items, ...secondPage.assets.items].map(({ id }) => id);
      expect(new Set(ids).size).toBe(3);
    });

    it('should order by fileSizeInBytes', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const sizes = [12_334, 599, 123_456];
      const assetIds: string[] = [];
      for (const fileSizeInByte of sizes) {
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        await ctx.newExif({ assetId: asset.id, fileSizeInByte });
        assetIds.push(asset.id);
      }

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        orderBy: { field: SearchOrderField.FileSizeInBytes, direction: AssetOrder.Asc },
      });

      expect(response.assets.items.map(({ id }) => id)).toEqual([assetIds[1], assetIds[0], assetIds[2]]);
    });

    it('should order smart search results by embedding distance with cursor offsets', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const searchRepository = ctx.get(SearchRepository);

      const assetIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        await searchRepository.upsert(asset.id, unitVector(i));
        assetIds.push(asset.id);
      }

      const options = { filter: {}, embedding: unitVector(0) };
      const scope = { userIds: [user.id], lockedOwnerId: user.id, privateOwnerId: null };
      const firstPage = await searchRepository.searchSmartV3({ take: 2 }, options, scope);
      expect(firstPage.items.length).toBe(2);
      expect(firstPage.items[0].id).toBe(assetIds[0]);
      expect(firstPage.hasNextPage).toBe(true);

      const secondPage = await searchRepository.searchSmartV3({ take: 2, skip: 2 }, options, scope);
      expect(secondPage.items.length).toBe(1);
      expect(secondPage.hasNextPage).toBe(false);
    });
  });

  describe('video frames', () => {
    const vector = (values: Record<number, number>) =>
      JSON.stringify(Array.from({ length: 512 }, (_, i) => values[i] ?? 0));

    const newRankedAssets = async (ctx: ReturnType<typeof setup>['ctx'], ownerId: string, options = {}) => {
      const searchRepository = ctx.get(SearchRepository);
      // a video whose thumbnail does not match, but one of its frames does
      const { asset: video } = await ctx.newAsset({ ownerId, type: AssetType.Video, ...options });
      await searchRepository.upsert(video.id, unitVector(5));
      await searchRepository.replaceFrames(video.id, [
        { frameTimestamp: 1000, embedding: unitVector(0) },
        { frameTimestamp: 2000, embedding: vector({ 0: 0.9, 1: 0.1 }) },
      ]);
      // a photo that matches reasonably well
      const { asset: photo } = await ctx.newAsset({ ownerId });
      await searchRepository.upsert(photo.id, vector({ 0: 0.8, 1: 0.6 }));
      // a photo that does not match
      const { asset: other } = await ctx.newAsset({ ownerId });
      await searchRepository.upsert(other.id, unitVector(1));
      return { video, photo, other };
    };

    it('should rank a video by its best frame and list it once', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const searchRepository = ctx.get(SearchRepository);
      const { video, photo, other } = await newRankedAssets(ctx, user.id);

      const options = { filter: {}, embedding: unitVector(0) };
      const scope = { userIds: [user.id], lockedOwnerId: user.id, privateOwnerId: null };
      const result = await searchRepository.searchSmartV3({ take: 10 }, options, scope);
      expect(result.items.map(({ id }) => id)).toEqual([video.id, photo.id, other.id]);

      const legacy = await searchRepository.searchSmart(
        { page: 1, size: 10 },
        { embedding: unitVector(0), userIds: [user.id], privateScope: { privateMode: false, userId: user.id } },
      );
      expect(legacy.items.map(({ id }) => id)).toEqual([video.id, photo.id, other.id]);
    });

    it('should page through merged results without repeating assets', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const searchRepository = ctx.get(SearchRepository);
      const { video, photo, other } = await newRankedAssets(ctx, user.id);

      const options = { filter: {}, embedding: unitVector(0) };
      const scope = { userIds: [user.id], lockedOwnerId: user.id, privateOwnerId: null };
      const pages = [];
      for (let skip = 0; skip < 3; skip++) {
        pages.push(await searchRepository.searchSmartV3({ take: 1, skip }, options, scope));
      }

      expect(pages.map(({ items }) => items.map(({ id }) => id))).toEqual([[video.id], [photo.id], [other.id]]);
      expect(pages.map(({ hasNextPage }) => hasNextPage)).toEqual([true, true, false]);

      const legacyPage = await searchRepository.searchSmart(
        { page: 2, size: 1 },
        { embedding: unitVector(0), userIds: [user.id], privateScope: { privateMode: false, userId: user.id } },
      );
      expect(legacyPage.items.map(({ id }) => id)).toEqual([photo.id]);
      expect(legacyPage.hasNextPage).toBe(true);
    });

    it('should apply the search filters to frame matches', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const searchRepository = ctx.get(SearchRepository);
      const { photo, other } = await newRankedAssets(ctx, user.id, { isPrivate: true });

      const options = { filter: {}, embedding: unitVector(0) };
      const scope = { userIds: [user.id], lockedOwnerId: user.id, privateOwnerId: null };
      const result = await searchRepository.searchSmartV3({ take: 10 }, options, scope);
      expect(result.items.map(({ id }) => id)).toEqual([photo.id, other.id]);
    });

    it('should not return frames of another user', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      const searchRepository = ctx.get(SearchRepository);
      await newRankedAssets(ctx, stranger.id);

      const options = { filter: {}, embedding: unitVector(0) };
      const scope = { userIds: [user.id], lockedOwnerId: user.id, privateOwnerId: null };
      const result = await searchRepository.searchSmartV3({ take: 10 }, options, scope);
      expect(result.items).toEqual([]);
    });

    it('should replace the frames of a video', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const searchRepository = ctx.get(SearchRepository);
      const { video } = await newRankedAssets(ctx, user.id);

      await searchRepository.replaceFrames(video.id, [{ frameTimestamp: 500, embedding: unitVector(3) }]);

      await expect(
        ctx.database
          .selectFrom('smart_search_frame')
          .select('frameTimestamp')
          .where('assetId', '=', video.id)
          .execute(),
      ).resolves.toEqual([{ frameTimestamp: 500 }]);
    });
  });

  describe('private mode', () => {
    it('should filter the legacy metadata search by the private flag while the mode is on', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      await ctx.newExif({ assetId: plain.id, make: 'Canon' });
      await ctx.newExif({ assetId: hidden.id, make: 'Canon' });
      const auth = factory.auth({ user, session: { privateMode: true } });

      const onlyPrivate = await sut.searchMetadata(auth, { isPrivate: true, size: 10 });
      expect(onlyPrivate.assets.items.map(({ id }) => id)).toEqual([hidden.id]);

      const noPrivate = await sut.searchMetadata(auth, { isPrivate: false, size: 10 });
      expect(noPrivate.assets.items.map(({ id }) => id)).toEqual([plain.id]);

      const random = await sut.searchRandom(auth, { isPrivate: true, size: 10 });
      expect(random.map(({ id }) => id)).toEqual([hidden.id]);
    });

    it('should hide private assets from the legacy search endpoints outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { publicAsset } = await newPrivatePair(ctx, user.id);
      const auth = factory.auth({ user, session: { privateMode: false } });

      const metadata = await sut.searchMetadata(auth, { size: 250 });
      expect(ids(metadata.assets.items)).toEqual([publicAsset.id]);
      await expect(sut.searchStatistics(auth, {})).resolves.toEqual({ total: 1 });
      expect(ids(await sut.searchRandom(auth, { size: 250 }))).toEqual([publicAsset.id]);
      expect(ids(await sut.searchLargeAssets(auth, { size: 250 }))).toEqual([publicAsset.id]);
    });

    it('should return private assets from the legacy search endpoints in private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { publicAsset, privateAsset } = await newPrivatePair(ctx, user.id);
      const auth = factory.auth({ user, session: { privateMode: true } });
      const expected = [publicAsset.id, privateAsset.id].toSorted();

      const metadata = await sut.searchMetadata(auth, { size: 250 });
      expect(ids(metadata.assets.items)).toEqual(expected);
      await expect(sut.searchStatistics(auth, {})).resolves.toEqual({ total: 2 });
      expect(ids(await sut.searchRandom(auth, { size: 250 }))).toEqual(expected);
      expect(ids(await sut.searchLargeAssets(auth, { size: 250 }))).toEqual(expected);
    });

    it('should hide private assets from the new search shape outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { publicAsset } = await newPrivatePair(ctx, user.id);
      const auth = factory.auth({ user, session: { privateMode: false } });

      const metadata = await sut.searchMetadata(auth, { size: 250, filter: {} });
      expect(ids(metadata.assets.items)).toEqual([publicAsset.id]);
      await expect(sut.searchStatistics(auth, { filter: {} })).resolves.toEqual({ total: 1 });
      expect(ids(await sut.searchRandom(auth, { size: 250, filter: {} }))).toEqual([publicAsset.id]);
    });

    it('should return private assets from the new search shape in private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { publicAsset, privateAsset } = await newPrivatePair(ctx, user.id);
      const auth = factory.auth({ user, session: { privateMode: true } });

      const metadata = await sut.searchMetadata(auth, { size: 250, filter: {} });
      expect(ids(metadata.assets.items)).toEqual([publicAsset.id, privateAsset.id].toSorted());
      await expect(sut.searchStatistics(auth, { filter: { isPrivate: { eq: true } } })).resolves.toEqual({ total: 1 });
      expect(ids(await sut.searchRandom(auth, { size: 250, filter: { isPrivate: { eq: true } } }))).toEqual([
        privateAsset.id,
      ]);
    });

    it('should reject a filter asking for private assets outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user, session: { privateMode: false } });

      await expect(sut.searchMetadata(auth, { size: 250, filter: { isPrivate: { eq: true } } })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it("should never return a partner's private asset", async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });
      const { publicAsset } = await newPrivatePair(ctx, partner.id);

      for (const privateMode of [false, true]) {
        const auth = factory.auth({ user, session: { privateMode } });
        const legacy = await sut.searchMetadata(auth, { size: 250 });
        expect(ids(legacy.assets.items)).toEqual([publicAsset.id]);
        const v3 = await sut.searchMetadata(auth, { size: 250, filter: {} });
        expect(ids(v3.assets.items)).toEqual([publicAsset.id]);
        await expect(sut.searchStatistics(auth, { filter: {} })).resolves.toEqual({ total: 1 });
      }
    });

    it('should scope smart search by the private owner', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const searchRepository = ctx.get(SearchRepository);
      const { asset: publicAsset } = await ctx.newAsset({ ownerId: user.id });
      await searchRepository.upsert(publicAsset.id, unitVector(0));
      const { asset: privateAsset } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      await searchRepository.upsert(privateAsset.id, unitVector(1));

      const options = { filter: {}, embedding: unitVector(0) };
      const hidden = await searchRepository.searchSmartV3({ take: 10 }, options, {
        userIds: [user.id],
        lockedOwnerId: user.id,
        privateOwnerId: null,
      });
      expect(ids(hidden.items)).toEqual([publicAsset.id]);

      const shown = await searchRepository.searchSmartV3({ take: 10 }, options, {
        userIds: [user.id],
        lockedOwnerId: user.id,
        privateOwnerId: user.id,
      });
      expect(ids(shown.items)).toEqual([publicAsset.id, privateAsset.id].toSorted());

      const legacyHidden = await searchRepository.searchSmart(
        { page: 1, size: 10 },
        { ...options, userIds: [user.id], privateScope: { privateMode: false, userId: user.id } },
      );
      expect(ids(legacyHidden.items)).toEqual([publicAsset.id]);
    });

    it('should hide private assets from the explore cities outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      for (let i = 0; i < 5; i++) {
        const { asset: publicAsset } = await ctx.newAsset({ ownerId: user.id });
        await ctx.newExif({ assetId: publicAsset.id, city: 'Oslo' });
        const { asset: privateAsset } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
        await ctx.newExif({ assetId: privateAsset.id, city: 'Bergen' });
      }

      const auth = factory.auth({ user, session: { privateMode: false } });
      const [cities] = await sut.getExploreData(auth);
      expect(cities.items.map(({ value }) => value)).toEqual(['Oslo']);

      const privateAuth = factory.auth({ user, session: { privateMode: true } });
      const [privateCities] = await sut.getExploreData(privateAuth);
      expect(privateCities.items.map(({ value }) => value).toSorted()).toEqual(['Bergen', 'Oslo']);
    });

    it('should hide private assets from the recently added explore data outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { publicAsset, privateAsset } = await newPrivatePair(ctx, user.id);

      const auth = factory.auth({ user, session: { privateMode: false } });
      const [, recents] = await sut.getExploreData(auth);
      expect(ids(recents.items.map(({ data }) => data))).toEqual([publicAsset.id]);

      const privateAuth = factory.auth({ user, session: { privateMode: true } });
      const [, privateRecents] = await sut.getExploreData(privateAuth);
      expect(ids(privateRecents.items.map(({ data }) => data))).toEqual([publicAsset.id, privateAsset.id].toSorted());
    });

    it('should hide private assets from the assets by city outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { publicAsset, privateAsset } = await newPrivatePair(ctx, user.id);

      const auth = factory.auth({ user, session: { privateMode: false } });
      expect(ids(await sut.getAssetsByCity(auth))).toEqual([publicAsset.id]);

      const privateAuth = factory.auth({ user, session: { privateMode: true } });
      expect(ids(await sut.getAssetsByCity(privateAuth))).toEqual([publicAsset.id, privateAsset.id].toSorted());
    });

    it('should hide private assets from the search suggestions outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      await newPrivatePair(ctx, user.id);
      const dto = { type: SearchSuggestionType.CAMERA_MAKE, includeNull: false };

      const auth = factory.auth({ user, session: { privateMode: false } });
      await expect(sut.getSearchSuggestions(auth, dto)).resolves.toEqual(['Canon']);

      const privateAuth = factory.auth({ user, session: { privateMode: true } });
      const suggestions = await sut.getSearchSuggestions(privateAuth, dto);
      expect(suggestions).toHaveLength(2);
      expect(suggestions).toEqual(expect.arrayContaining(['Canon', 'Leica']));
    });
  });
});
