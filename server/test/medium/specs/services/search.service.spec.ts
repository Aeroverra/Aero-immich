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
import { StackRepository } from 'src/repositories/stack.repository';
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
      StackRepository,
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

/** One tagged, one album, two plain (one favorite) and one trashed asset for the same user */
const newLibrary = async () => {
  const { sut, ctx } = setup();
  const { user } = await ctx.newUser();
  const { asset: tagged } = await ctx.newAsset({ ownerId: user.id });
  const { asset: inAlbum } = await ctx.newAsset({ ownerId: user.id });
  const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
  const { asset: plainFavorite } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
  const { asset: trashed } = await ctx.newAsset({ ownerId: user.id });
  await ctx.softDeleteAsset(trashed.id);

  const { tag } = await ctx.newTag({ userId: user.id, value: 'holiday', color: '#000000' });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [tagged.id] });
  const { album } = await ctx.newAlbum({ ownerId: user.id });
  await ctx.newAlbumAsset({ albumId: album.id, assetId: inAlbum.id });

  const auth = factory.auth({ user: { id: user.id } });
  return { sut, ctx, user, auth, tagged, inAlbum, plain, plainFavorite, trashed };
};

/** Beach is a child of Holiday: leaving out Holiday leaves out Beach photos too */
const newTaggedLibrary = async () => {
  const library = await newLibrary();
  const { ctx, user, plain, plainFavorite, inAlbum } = library;
  const { tag: holiday } = await ctx.newTag({ userId: user.id, value: 'Holiday' });
  const { tag: beach } = await ctx.newTag({ userId: user.id, value: 'Holiday/Beach', parentId: holiday.id });
  const { tag: work } = await ctx.newTag({ userId: user.id, value: 'Work' });
  await ctx.newTagAsset({ tagIds: [beach.id], assetIds: [plain.id] });
  await ctx.newTagAsset({ tagIds: [work.id], assetIds: [plain.id, plainFavorite.id] });
  await ctx.newTagAsset({ tagIds: [holiday.id], assetIds: [inAlbum.id] });
  return { ...library, holiday, beach, work };
};

/** inAlbum is in Trip, plain is in Trip and Party */
const newAlbumLibrary = async () => {
  const library = await newLibrary();
  const { ctx, user, inAlbum, plain } = library;
  const { album: trip } = await ctx.newAlbum({ ownerId: user.id }, [inAlbum.id, plain.id]);
  const { album: party } = await ctx.newAlbum({ ownerId: user.id }, [plain.id]);
  return { ...library, trip, party };
};

/** a phone upload from June 2026, and a Google Photos import (added in September) uploaded to Google in 2019 */
const newUploadLibrary = async () => {
  const { sut, ctx } = setup();
  const { user } = await ctx.newUser();
  const { asset: phone } = await ctx.newAsset({ ownerId: user.id, createdAt: new Date('2026-06-15T12:00:00Z') });
  const { asset: google } = await ctx.newAsset({ ownerId: user.id, createdAt: new Date('2026-09-20T12:00:00Z') });
  await ctx.newMetadata({
    assetId: google.id,
    key: 'google-photos',
    value: { uploadedAt: '2019-03-10T08:30:00Z', takenAt: '2018-12-24T18:00:00Z' },
  });
  const auth = factory.auth({ user: { id: user.id } });
  return { sut, ctx, user, auth, phone, google };
};

/**
 * Named Ann and Bob, a person without a name and a hidden one, and photos of them: alone, together,
 * with a face nobody is assigned to, with faces that were hidden or deleted, and with nobody at all
 */
const newPeopleLibrary = async () => {
  const { sut, ctx } = setup();
  const { user } = await ctx.newUser();
  const { person: ann } = await ctx.newPerson({ ownerId: user.id, name: 'Ann' });
  const { person: bob } = await ctx.newPerson({ ownerId: user.id, name: 'Bob' });
  const { person: unnamed } = await ctx.newPerson({ ownerId: user.id, name: '' });
  const { person: hidden } = await ctx.newPerson({ ownerId: user.id, name: '', isHidden: true });

  const newPhoto = async (faces: { personGroupId?: string | null; isVisible?: boolean; deletedAt?: Date }[]) => {
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    for (const face of faces) {
      await ctx.newAssetFace({ assetId: asset.id, ...face });
    }
    return asset;
  };

  const annAlone = await newPhoto([{ personGroupId: ann.personGroupId }]);
  const annTwice = await newPhoto([{ personGroupId: ann.personGroupId }, { personGroupId: ann.personGroupId }]);
  const annAndBob = await newPhoto([{ personGroupId: ann.personGroupId }, { personGroupId: bob.personGroupId }]);
  const annAndStranger = await newPhoto([{ personGroupId: ann.personGroupId }, { personGroupId: null }]);
  const annAndGoneFaces = await newPhoto([
    { personGroupId: ann.personGroupId },
    { personGroupId: bob.personGroupId, isVisible: false },
    { personGroupId: null, deletedAt: new Date() },
  ]);
  const unnamedOnly = await newPhoto([{ personGroupId: unnamed.personGroupId }]);
  const hiddenOnly = await newPhoto([{ personGroupId: hidden.personGroupId }]);
  const strangerOnly = await newPhoto([{ personGroupId: null }]);
  const nobody = await newPhoto([]);
  const onlyHiddenFace = await newPhoto([{ personGroupId: null, isVisible: false }]);

  const auth = factory.auth({ user: { id: user.id } });
  return {
    sut,
    ctx,
    user,
    auth,
    ann,
    bob,
    unnamed,
    annAlone,
    annTwice,
    annAndBob,
    annAndStranger,
    annAndGoneFaces,
    unnamedOnly,
    hiddenOnly,
    strangerOnly,
    nobody,
    onlyHiddenFace,
  };
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

    it('should tell which stack each result belongs to', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      const { asset: primaryAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: stackedAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: unstackedAsset } = await ctx.newAsset({ ownerId: user.id });
      const { stack } = await ctx.newStack({ ownerId: user.id }, [primaryAsset.id, stackedAsset.id]);

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, { size: 250 });

      const stacks = Object.fromEntries(response.assets.items.map((asset) => [asset.id, asset.stack]));
      const expected = { id: stack.id, primaryAssetId: primaryAsset.id, assetCount: 2, source: 'manual' };
      expect(stacks[primaryAsset.id]).toEqual(expected);
      expect(stacks[stackedAsset.id]).toEqual(expected);
      expect(stacks[unstackedAsset.id]).toBeNull();
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

  describe('untagged and not-in-album filters', () => {
    it('should return only untagged assets for the deprecated tagIds: null', async () => {
      const { sut, auth, inAlbum, plain, plainFavorite } = await newLibrary();

      const response = await sut.searchMetadata(auth, { size: 250, tagIds: null });

      expect(ids(response.assets.items)).toEqual(ids([inAlbum, plain, plainFavorite]));
    });

    it('should return only assets outside every album for the deprecated isNotInAlbum', async () => {
      const { sut, auth, tagged, plain, plainFavorite } = await newLibrary();

      const response = await sut.searchMetadata(auth, { size: 250, isNotInAlbum: true });

      expect(ids(response.assets.items)).toEqual(ids([tagged, plain, plainFavorite]));
    });

    // the structured shape only excludes trashed assets when the filter says so
    it('should return only untagged assets for hasTags: false', async () => {
      const { sut, auth, inAlbum, plain, plainFavorite, trashed } = await newLibrary();

      const response = await sut.searchMetadata(auth, { size: 250, filter: { hasTags: { eq: false } } });
      expect(ids(response.assets.items)).toEqual(ids([inAlbum, plain, plainFavorite, trashed]));

      const untrashed = await sut.searchMetadata(auth, {
        size: 250,
        filter: { hasTags: { eq: false }, trashedAt: { eq: null } },
      });
      expect(ids(untrashed.assets.items)).toEqual(ids([inAlbum, plain, plainFavorite]));
    });

    it('should return only assets outside every album for hasAlbums: false', async () => {
      const { sut, auth, tagged, plain, plainFavorite } = await newLibrary();

      const response = await sut.searchMetadata(auth, {
        size: 250,
        filter: { hasAlbums: { eq: false }, trashedAt: { eq: null } },
      });

      expect(ids(response.assets.items)).toEqual(ids([tagged, plain, plainFavorite]));
    });

    it('should combine both deprecated flags with a favorite filter', async () => {
      const { sut, auth, plainFavorite } = await newLibrary();

      const response = await sut.searchMetadata(auth, {
        size: 250,
        tagIds: null,
        isNotInAlbum: true,
        isFavorite: true,
      });

      expect(response.assets.items).toEqual([expect.objectContaining({ id: plainFavorite.id })]);
    });

    it('should combine both structured filters with a favorite filter', async () => {
      const { sut, auth, plainFavorite } = await newLibrary();

      const response = await sut.searchMetadata(auth, {
        size: 250,
        filter: { hasTags: { eq: false }, hasAlbums: { eq: false }, isFavorite: { eq: true } },
      });

      expect(response.assets.items).toEqual([expect.objectContaining({ id: plainFavorite.id })]);
    });

    it('should keep excluding trashed assets unless withDeleted is set', async () => {
      const { sut, auth, plain, plainFavorite, trashed } = await newLibrary();

      const response = await sut.searchMetadata(auth, { size: 250, tagIds: null, isNotInAlbum: true });
      expect(ids(response.assets.items)).toEqual(ids([plain, plainFavorite]));

      const withDeleted = await sut.searchMetadata(auth, {
        size: 250,
        tagIds: null,
        isNotInAlbum: true,
        withDeleted: true,
      });
      expect(ids(withDeleted.assets.items)).toEqual(ids([plain, plainFavorite, trashed]));
    });

    it('should apply both deprecated flags to smart search', async () => {
      const { ctx, user, tagged, inAlbum, plain, plainFavorite, trashed } = await newLibrary();
      const searchRepository = ctx.get(SearchRepository);
      const assets = [tagged, inAlbum, plain, plainFavorite, trashed];
      for (const [index, asset] of assets.entries()) {
        await searchRepository.upsert(asset.id, unitVector(index));
      }

      const { items } = await searchRepository.searchSmart(
        { page: 1, size: 100 },
        { embedding: unitVector(0), userIds: [user.id], tagIds: null, isNotInAlbum: true },
      );

      expect(ids(items)).toEqual(ids([plain, plainFavorite]));
    });

    it('should apply both structured filters to smart search', async () => {
      const { ctx, user, tagged, inAlbum, plain, plainFavorite, trashed } = await newLibrary();
      const searchRepository = ctx.get(SearchRepository);
      const assets = [tagged, inAlbum, plain, plainFavorite, trashed];
      for (const [index, asset] of assets.entries()) {
        await searchRepository.upsert(asset.id, unitVector(index));
      }

      const { items } = await searchRepository.searchSmartV3(
        { take: 100 },
        {
          filter: { hasTags: { eq: false }, hasAlbums: { eq: false }, trashedAt: { eq: null } },
          embedding: unitVector(0),
        },
        { userIds: [user.id], lockedOwnerId: user.id, privateOwnerId: null },
      );

      expect(ids(items)).toEqual(ids([plain, plainFavorite]));
    });
  });

  describe('excluded tags', () => {
    it('should leave out assets with an excluded tag or one of its child tags', async () => {
      const { sut, auth, holiday, tagged, plainFavorite } = await newTaggedLibrary();

      const response = await sut.searchMetadata(auth, { size: 250, excludeTagIds: [holiday.id] });

      expect(ids(response.assets.items)).toEqual(ids([tagged, plainFavorite]));
    });

    it('should combine included and excluded tags', async () => {
      const { sut, auth, work, beach, plainFavorite } = await newTaggedLibrary();

      const response = await sut.searchMetadata(auth, { size: 250, tagIds: [work.id], excludeTagIds: [beach.id] });

      expect(ids(response.assets.items)).toEqual(ids([plainFavorite]));
    });

    it('should apply excluded tags to smart search', async () => {
      const { ctx, user, holiday, tagged, inAlbum, plain, plainFavorite } = await newTaggedLibrary();
      const searchRepository = ctx.get(SearchRepository);
      for (const [index, asset] of [tagged, inAlbum, plain, plainFavorite].entries()) {
        await searchRepository.upsert(asset.id, unitVector(index));
      }

      const { items } = await searchRepository.searchSmart(
        { page: 1, size: 100 },
        { embedding: unitVector(0), userIds: [user.id], excludeTagIds: [holiday.id] },
      );

      expect(ids(items)).toEqual(ids([tagged, plainFavorite]));
    });

    it('should refuse to exclude a hidden tag while private mode is locked', async () => {
      const { sut, ctx, auth, user } = await newTaggedLibrary();
      const { tag: secret } = await ctx.newTag({ userId: user.id, value: 'Secret', isHidden: true });

      await expect(sut.searchMetadata(auth, { size: 250, excludeTagIds: [secret.id] })).rejects.toThrow(
        'Not found or no tag.read access',
      );
    });
  });

  describe('video length', () => {
    it('should keep to videos within the length bounds', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: short } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, duration: 5000 });
      const { asset: minute } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, duration: 60_000 });
      const { asset: long } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, duration: 600_000 });
      await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
      const auth = factory.auth({ user: { id: user.id } });

      const atLeast = await sut.searchMetadata(auth, { size: 250, minDuration: 10_000 });
      const atMost = await sut.searchMetadata(auth, { size: 250, maxDuration: 60_000 });
      const between = await sut.searchMetadata(auth, { size: 250, minDuration: 10_000, maxDuration: 60_000 });

      expect(ids(atLeast.assets.items)).toEqual(ids([minute, long]));
      // photos have no length, so a bound alone keeps to videos
      expect(ids(atMost.assets.items)).toEqual(ids([short, minute]));
      expect(ids(between.assets.items)).toEqual(ids([minute]));
    });

    it('should apply the length bounds to smart search', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: short } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, duration: 5000 });
      const { asset: long } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, duration: 600_000 });
      const searchRepository = ctx.get(SearchRepository);
      await searchRepository.upsert(short.id, unitVector(0));
      await searchRepository.upsert(long.id, unitVector(1));

      const { items } = await searchRepository.searchSmart(
        { page: 1, size: 100 },
        { embedding: unitVector(0), userIds: [user.id], minDuration: 60_000 },
      );

      expect(ids(items)).toEqual(ids([long]));
    });
  });

  describe('people and faces', () => {
    it('should keep to photos where the picked person is the only one', async () => {
      const { sut, auth, ann, annAlone, annTwice, annAndGoneFaces } = await newPeopleLibrary();

      const response = await sut.searchMetadata(auth, {
        size: 250,
        personIds: [ann.personGroupId],
        onlyPersonIds: true,
      });

      // hidden and deleted faces are not in the photo anymore
      expect(ids(response.assets.items)).toEqual(ids([annAlone, annTwice, annAndGoneFaces]));
    });

    it('should need every picked person and nobody else', async () => {
      const { sut, auth, ann, bob, annAndBob } = await newPeopleLibrary();

      const response = await sut.searchMetadata(auth, {
        size: 250,
        personIds: [ann.personGroupId, bob.personGroupId],
        onlyPersonIds: true,
      });

      expect(ids(response.assets.items)).toEqual(ids([annAndBob]));
    });

    it('should still find a person with others around without onlyPersonIds', async () => {
      const { sut, auth, ann, annAlone, annTwice, annAndBob, annAndStranger, annAndGoneFaces } =
        await newPeopleLibrary();

      const response = await sut.searchMetadata(auth, { size: 250, personIds: [ann.personGroupId] });

      expect(ids(response.assets.items)).toEqual(ids([annAlone, annTwice, annAndBob, annAndStranger, annAndGoneFaces]));
    });

    it('should keep to photos where someone else is there too', async () => {
      const { sut, auth, ann, annAndBob, annAndStranger } = await newPeopleLibrary();

      const response = await sut.searchMetadata(auth, {
        size: 250,
        personIds: [ann.personGroupId],
        onlyPersonIds: false,
      });

      // a face nobody is assigned to is someone else as well
      expect(ids(response.assets.items)).toEqual(ids([annAndBob, annAndStranger]));
    });

    it('should ignore onlyPersonIds without people', async () => {
      const { sut, auth } = await newPeopleLibrary();

      const only = await sut.searchMetadata(auth, { size: 250, onlyPersonIds: true });
      const withOthers = await sut.searchMetadata(auth, { size: 250, onlyPersonIds: false });

      expect(only.assets.items).toHaveLength(10);
      expect(withOthers.assets.items).toHaveLength(10);
    });

    it('should find photos with nobody in them, and with anybody', async () => {
      const library = await newPeopleLibrary();
      const { sut, auth, nobody, onlyHiddenFace } = library;

      const without = await sut.searchMetadata(auth, { size: 250, hasPeople: false });
      const withPeople = await sut.searchMetadata(auth, { size: 250, hasPeople: true });

      expect(ids(without.assets.items)).toEqual(ids([nobody, onlyHiddenFace]));
      expect(ids(withPeople.assets.items)).toEqual(
        ids([
          library.annAlone,
          library.annTwice,
          library.annAndBob,
          library.annAndStranger,
          library.annAndGoneFaces,
          library.unnamedOnly,
          library.hiddenOnly,
          library.strangerOnly,
        ]),
      );
    });

    it('should find photos with a face nobody has named', async () => {
      const library = await newPeopleLibrary();
      const { sut, auth, annAndStranger, unnamedOnly, strangerOnly } = library;

      const unnamed = await sut.searchMetadata(auth, { size: 250, hasUnnamedFaces: true });
      const named = await sut.searchMetadata(auth, { size: 250, hasUnnamedFaces: false });

      // a hidden person was set aside on purpose, a hidden face is not shown
      expect(ids(unnamed.assets.items)).toEqual(ids([annAndStranger, unnamedOnly, strangerOnly]));
      expect(ids(named.assets.items)).toEqual(
        ids([
          library.annAlone,
          library.annTwice,
          library.annAndBob,
          library.annAndGoneFaces,
          library.hiddenOnly,
          library.nobody,
          library.onlyHiddenFace,
        ]),
      );
    });

    it('should find photos without anyone named, whether faces were found or not', async () => {
      const library = await newPeopleLibrary();
      const { sut, ctx, user, auth, unnamedOnly, hiddenOnly, strangerOnly, nobody, onlyHiddenFace } = library;
      // a hidden person keeps its name
      const { person: dan } = await ctx.newPerson({ ownerId: user.id, name: 'Dan', isHidden: true });
      const { asset: danAlone } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAssetFace({ assetId: danAlone.id, personGroupId: dan.personGroupId });

      const nobodyNamed = await sut.searchMetadata(auth, { size: 250, hasNamedFaces: false });
      const named = await sut.searchMetadata(auth, { size: 250, hasNamedFaces: true });
      const onlyUnnamed = await sut.searchMetadata(auth, { size: 250, hasNamedFaces: false, hasUnnamedFaces: true });

      expect(ids(nobodyNamed.assets.items)).toEqual(
        ids([unnamedOnly, hiddenOnly, strangerOnly, nobody, onlyHiddenFace]),
      );
      expect(ids(named.assets.items)).toEqual(
        ids([
          library.annAlone,
          library.annTwice,
          library.annAndBob,
          library.annAndStranger,
          library.annAndGoneFaces,
          danAlone,
        ]),
      );
      expect(ids(onlyUnnamed.assets.items)).toEqual(ids([unnamedOnly, strangerOnly]));
    });

    it("should go by the searching user's names", async () => {
      const { sut, ctx, auth, unnamed, unnamedOnly, strangerOnly, annAndStranger } = await newPeopleLibrary();
      const { user: other } = await ctx.newUser();
      // another user's name for the same person group does not name it for this user
      await ctx.newPerson({ ownerId: other.id, personGroupId: unnamed.personGroupId, name: 'Carol' });

      const response = await sut.searchMetadata(auth, { size: 250, hasUnnamedFaces: true });

      expect(ids(response.assets.items)).toEqual(ids([annAndStranger, unnamedOnly, strangerOnly]));
    });

    it('should combine the face filters with others and count them in statistics', async () => {
      const { sut, auth, ann } = await newPeopleLibrary();

      await expect(sut.searchStatistics(auth, { hasPeople: false })).resolves.toEqual({ total: 2 });
      await expect(
        sut.searchStatistics(auth, { hasUnnamedFaces: true, personIds: [ann.personGroupId] }),
      ).resolves.toEqual({ total: 1 });
    });

    it('should apply the face filters to smart search', async () => {
      const { ctx, user, ann, annAlone, annAndBob, nobody, strangerOnly } = await newPeopleLibrary();
      const searchRepository = ctx.get(SearchRepository);
      for (const [index, asset] of [annAlone, annAndBob, nobody, strangerOnly].entries()) {
        await searchRepository.upsert(asset.id, unitVector(index));
      }

      const only = await searchRepository.searchSmart(
        { page: 1, size: 100 },
        { embedding: unitVector(1), userIds: [user.id], personIds: [ann.personGroupId], onlyPersonIds: true },
      );
      const empty = await searchRepository.searchSmart(
        { page: 1, size: 100 },
        { embedding: unitVector(1), userIds: [user.id], hasPeople: false },
      );
      const unnamed = await searchRepository.searchSmart(
        { page: 1, size: 100 },
        { embedding: unitVector(1), userIds: [user.id], hasUnnamedFaces: true },
      );

      expect(ids(only.items)).toEqual(ids([annAlone]));
      expect(ids(empty.items)).toEqual(ids([nobody]));
      expect(ids(unnamed.items)).toEqual(ids([strangerOnly]));
    });
  });

  describe('albums', () => {
    it('should leave out assets in any excluded album', async () => {
      const { sut, auth, trip, party, tagged, plainFavorite } = await newAlbumLibrary();

      const response = await sut.searchMetadata(auth, { size: 250, excludeAlbumIds: [trip.id, party.id] });

      expect(ids(response.assets.items)).toEqual(ids([tagged, plainFavorite]));
    });

    it('should combine searched and excluded albums', async () => {
      const { sut, auth, trip, party, inAlbum } = await newAlbumLibrary();

      const response = await sut.searchMetadata(auth, { size: 250, albumIds: [trip.id], excludeAlbumIds: [party.id] });

      expect(ids(response.assets.items)).toEqual(ids([inAlbum]));
    });

    it('should apply excluded albums to smart search', async () => {
      const { ctx, user, party, tagged, inAlbum, plain, plainFavorite } = await newAlbumLibrary();
      const searchRepository = ctx.get(SearchRepository);
      for (const [index, asset] of [tagged, inAlbum, plain, plainFavorite].entries()) {
        await searchRepository.upsert(asset.id, unitVector(index));
      }

      const { items } = await searchRepository.searchSmart(
        { page: 1, size: 100 },
        { embedding: unitVector(0), userIds: [user.id], excludeAlbumIds: [party.id] },
      );

      expect(ids(items)).toEqual(ids([tagged, inAlbum, plainFavorite]));
    });

    it('should smart search everything in a shared album, whoever added it', async () => {
      const { ctx, user, trip, inAlbum, plain } = await newAlbumLibrary();
      const { user: friend } = await ctx.newUser();
      const { asset: friendAsset } = await ctx.newAsset({ ownerId: friend.id });
      await ctx.newAlbumUser({ albumId: trip.id, userId: friend.id, role: AlbumUserRole.Editor });
      await ctx.newAlbumAsset({ albumId: trip.id, assetId: friendAsset.id });
      await ctx.newAsset({ ownerId: friend.id });
      const searchRepository = ctx.get(SearchRepository);
      for (const [index, asset] of [inAlbum, plain, friendAsset].entries()) {
        await searchRepository.upsert(asset.id, unitVector(index));
      }

      // the service leaves userIds out for an album search, after the album access check
      const { items } = await searchRepository.searchSmart(
        { page: 1, size: 100 },
        { embedding: unitVector(0), albumIds: [trip.id], privateScope: { privateMode: false, userId: user.id } },
      );

      expect(ids(items)).toEqual(ids([inAlbum, plain, friendAsset]));
    });

    it('should refuse to leave out an album the user cannot read', async () => {
      const { sut, ctx, auth } = await newAlbumLibrary();
      const { user: stranger } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: stranger.id });

      await expect(sut.searchMetadata(auth, { size: 250, excludeAlbumIds: [album.id] })).rejects.toThrow(
        'Not found or no album.read access',
      );
    });

    it('should refuse a hidden tag inside an album search while private mode is locked', async () => {
      const { sut, ctx, auth, user, trip } = await newAlbumLibrary();
      const { tag: secret } = await ctx.newTag({ userId: user.id, value: 'Secret', isHidden: true });

      await expect(sut.searchMetadata(auth, { size: 250, albumIds: [trip.id], tagIds: [secret.id] })).rejects.toThrow(
        'Not found or no tag.read access',
      );
    });
  });

  describe('upload date', () => {
    it('should use the Google Photos upload time for imported assets, else the creation date', async () => {
      const { sut, auth, phone, google } = await newUploadLibrary();

      const in2019 = await sut.searchMetadata(auth, {
        size: 250,
        uploadedAfter: new Date('2019-01-01T00:00:00Z'),
        uploadedBefore: new Date('2019-12-31T23:59:59.999Z'),
      });
      const sinceMay = await sut.searchMetadata(auth, { size: 250, uploadedAfter: new Date('2026-05-01T00:00:00Z') });
      const beforeMay = await sut.searchMetadata(auth, { size: 250, uploadedBefore: new Date('2026-05-01T00:00:00Z') });

      expect(ids(in2019.assets.items)).toEqual([google.id]);
      expect(ids(sinceMay.assets.items)).toEqual([phone.id]);
      expect(ids(beforeMay.assets.items)).toEqual([google.id]);
    });

    it('should include both bounds to the second', async () => {
      const { sut, auth, google } = await newUploadLibrary();

      const response = await sut.searchMetadata(auth, {
        size: 250,
        uploadedAfter: new Date('2019-03-10T08:30:00Z'),
        uploadedBefore: new Date('2019-03-10T08:30:00.999Z'),
      });

      expect(ids(response.assets.items)).toEqual([google.id]);
    });

    it('should fall back to the creation date for a malformed upload time', async () => {
      const { sut, ctx, auth, user } = await newUploadLibrary();
      const { asset: odd } = await ctx.newAsset({ ownerId: user.id, createdAt: new Date('2026-07-01T12:00:00Z') });
      await ctx.newMetadata({ assetId: odd.id, key: 'google-photos', value: { uploadedAt: 'yesterday' } });

      const response = await sut.searchMetadata(auth, {
        size: 250,
        uploadedAfter: new Date('2026-07-01T00:00:00Z'),
        uploadedBefore: new Date('2026-07-01T23:59:59Z'),
      });

      expect(ids(response.assets.items)).toEqual([odd.id]);
    });

    it('should apply the upload date to smart search', async () => {
      const { ctx, user, phone, google } = await newUploadLibrary();
      const searchRepository = ctx.get(SearchRepository);
      await searchRepository.upsert(phone.id, unitVector(0));
      await searchRepository.upsert(google.id, unitVector(1));

      const { items } = await searchRepository.searchSmart(
        { page: 1, size: 100 },
        { embedding: unitVector(0), userIds: [user.id], uploadedBefore: new Date('2020-01-01T00:00:00Z') },
      );

      expect(ids(items)).toEqual([google.id]);
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
    // eslint-disable-next-line unicorn/consistent-function-scoping
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
