import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AssetVisibility, SharedLinkType, StackSource } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PartnerRepository } from 'src/repositories/partner.repository';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository';
import { DB } from 'src/schema';
import { TimelineService } from 'src/services/timeline.service';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(TimelineService, {
    database: db || defaultDatabase,
    real: [AssetRepository, AccessRepository, PartnerRepository],
    mock: [LoggingRepository],
  });
};

const newBucketAssets = async (ctx: ReturnType<typeof setup>['ctx'], ownerId: string) => {
  const { asset: publicAsset } = await ctx.newAsset({ ownerId, localDateTime: new Date('1970-02-10') });
  const { asset: privateAsset } = await ctx.newAsset({
    ownerId,
    localDateTime: new Date('1970-02-11'),
    isPrivate: true,
  });
  await ctx.newExif({ assetId: publicAsset.id, make: 'Canon' });
  await ctx.newExif({ assetId: privateAsset.id, make: 'Canon' });
  return { publicAsset, privateAsset };
};

const newStackedAssets = async (ctx: ReturnType<typeof setup>['ctx'], ownerId: string) => {
  const assets = [];
  for (let day = 1; day <= 5; day++) {
    const { asset } = await ctx.newAsset({ ownerId, localDateTime: new Date(`1970-02-0${day}`) });
    await ctx.newExif({ assetId: asset.id, make: 'Canon' });
    assets.push(asset);
  }

  const [manualPrimary, manualChild, autoPrimary, autoChild, single] = assets;
  const { stack: manual } = await ctx.newStack({ ownerId }, [manualPrimary.id, manualChild.id]);
  const { stack: auto } = await ctx.newStack({ ownerId, source: StackSource.Auto }, [autoPrimary.id, autoChild.id]);

  return { manual, auto, manualPrimary, manualChild, autoPrimary, autoChild, single };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(TimelineService.name, () => {
  describe('getTimeBuckets', () => {
    it('should get time buckets by month', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const dates = [new Date('1970-01-01'), new Date('1970-02-10'), new Date('1970-02-11'), new Date('1970-02-11')];
      for (const localDateTime of dates) {
        const { asset } = await ctx.newAsset({ ownerId: user.id, localDateTime });
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      }

      const response = sut.getTimeBuckets(auth, {});
      await expect(response).resolves.toEqual([
        { count: 3, timeBucket: '1970-02-01' },
        { count: 1, timeBucket: '1970-01-01' },
      ]);
    });

    it('should return error if time bucket is requested with partners asset and archived', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const response1 = sut.getTimeBuckets(auth, { withPartners: true, visibility: AssetVisibility.Archive });
      await expect(response1).rejects.toBeInstanceOf(BadRequestException);
      await expect(response1).rejects.toThrow(
        'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );

      const response2 = sut.getTimeBuckets(auth, { withPartners: true });
      await expect(response2).rejects.toBeInstanceOf(BadRequestException);
      await expect(response2).rejects.toThrow(
        'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );
    });

    it('should return error if time bucket is requested with partners asset and favorite', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const response1 = sut.getTimeBuckets(auth, { withPartners: true, isFavorite: false });
      await expect(response1).rejects.toBeInstanceOf(BadRequestException);
      await expect(response1).rejects.toThrow(
        'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );

      const response2 = sut.getTimeBuckets(auth, { withPartners: true, isFavorite: true });
      await expect(response2).rejects.toBeInstanceOf(BadRequestException);
      await expect(response2).rejects.toThrow(
        'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );
    });

    it('should return error if time bucket is requested with partners asset and trash', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const response = sut.getTimeBuckets(auth, { withPartners: true, isTrashed: true });
      await expect(response).rejects.toBeInstanceOf(BadRequestException);
      await expect(response).rejects.toThrow(
        'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );
    });

    it('should return error if time bucket is requested with locked visibility for partner', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });

      const auth = factory.auth({ user, session: { hasElevatedPermission: true } });

      const response = sut.getTimeBuckets(auth, { userId: partner.id, visibility: AssetVisibility.Locked });
      await expect(response).rejects.toThrow("You may not access another user's locked timeline");
    });

    it('should not allow access for unrelated shared links', async () => {
      const { sut } = setup();
      const auth = factory.auth({ sharedLink: {} });
      const response = sut.getTimeBuckets(auth, {});
      await expect(response).rejects.toBeInstanceOf(BadRequestException);
      await expect(response).rejects.toThrow('Not found or no timeline.read access');
    });
  });

  describe('getTimeBucket', () => {
    it('should return time bucket', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        localDateTime: new Date('1970-02-12'),
        deletedAt: new Date(),
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      const auth = factory.auth({ user: { id: user.id } });
      const rawResponse = await sut.getTimeBucket(auth, { timeBucket: '1970-02-01', isTrashed: true });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual(expect.objectContaining({ isTrashed: [true] }));
    });

    it('should handle a bucket without any assets', async () => {
      const { sut } = setup();
      const rawResponse = await sut.getTimeBucket(factory.auth(), { timeBucket: '1970-02-01' });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual({
        city: [],
        country: [],
        createdAt: [],
        duration: [],
        id: [],
        visibility: [],
        isFavorite: [],
        isPrivate: [],
        isImage: [],
        isTrashed: [],
        livePhotoVideoId: [],
        fileCreatedAt: [],
        localOffsetHours: [],
        ownerId: [],
        projectionType: [],
        ratio: [],
        status: [],
        thumbhash: [],
      });
    });

    it('should handle 5 digit years', async () => {
      const { sut } = setup();
      const rawResponse = await sut.getTimeBucket(factory.auth(), { timeBucket: '012345-01-01' });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual(expect.objectContaining({ id: [] }));
    });

    it('should return time bucket in trash', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        localDateTime: new Date('1970-02-12'),
        deletedAt: new Date(),
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      const auth = factory.auth({ user: { id: user.id } });
      const rawResponse = await sut.getTimeBucket(auth, { timeBucket: '1970-02-01', isTrashed: true });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual(expect.objectContaining({ isTrashed: [true] }));
    });

    it('should return false for favorite status unless asset owner', async () => {
      const { sut, ctx } = setup();
      const [{ asset: asset1 }, { asset: asset2 }] = await Promise.all([
        ctx.newUser().then(async ({ user }) => {
          const result = await ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('1970-02-12'),
            localDateTime: new Date('1970-02-12'),
            isFavorite: true,
          });
          await ctx.newExif({ assetId: result.asset.id, make: 'Canon' });
          return result;
        }),

        ctx.newUser().then(async ({ user }) => {
          const result = await ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('1970-02-13'),
            localDateTime: new Date('1970-02-13'),
            isFavorite: true,
          });
          await ctx.newExif({ assetId: result.asset.id, make: 'Canon' });
          return result;
        }),
      ]);

      await Promise.all([
        ctx.newPartner({ sharedById: asset1.ownerId, sharedWithId: asset2.ownerId }),
        ctx.newPartner({ sharedById: asset2.ownerId, sharedWithId: asset1.ownerId }),
      ]);

      const auth1 = factory.auth({ user: { id: asset1.ownerId } });
      const rawResponse1 = await sut.getTimeBucket(auth1, {
        timeBucket: '1970-02-01',
        withPartners: true,
        visibility: AssetVisibility.Timeline,
      });
      const response1 = JSON.parse(rawResponse1);
      expect(response1).toEqual(expect.objectContaining({ id: [asset2.id, asset1.id], isFavorite: [false, true] }));

      const auth2 = factory.auth({ user: { id: asset2.ownerId } });
      const rawResponse2 = await sut.getTimeBucket(auth2, {
        timeBucket: '1970-02-01',
        withPartners: true,
        visibility: AssetVisibility.Timeline,
      });
      const response2 = JSON.parse(rawResponse2);
      expect(response2).toEqual(expect.objectContaining({ id: [asset2.id, asset1.id], isFavorite: [true, false] }));
    });
  });

  it('should strip geodata metadata if shared link without exif', async () => {
    const { sut, ctx } = setup();
    const sharedLinkRepo = ctx.get(SharedLinkRepository);

    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      localDateTime: new Date('1970-02-12'),
      deletedAt: new Date(),
    });
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

    const { id: sharedLinkId } = await sharedLinkRepo.create({
      allowUpload: false,
      key: Buffer.from('123'),
      type: SharedLinkType.Album,
      userId: user.id,
      albumId: album.id,
    });

    await ctx.newExif({ assetId: asset.id, city: 'Austin', country: 'USA' });
    const auth = factory.auth({ sharedLink: { id: sharedLinkId, showExif: false } });
    const rawResponse = await sut.getTimeBucket(auth, { albumId: album.id, timeBucket: '1970-02-01', isTrashed: true });
    const response = JSON.parse(rawResponse);
    expect(response).not.toEqual(expect.objectContaining({ city: expect.any(Array), country: expect.any(Array) }));
  });

  describe('private mode', () => {
    it('should exclude private assets from the buckets outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      await newBucketAssets(ctx, user.id);
      const auth = factory.auth({ user, session: { privateMode: false } });

      await expect(sut.getTimeBuckets(auth, {})).resolves.toEqual([{ count: 1, timeBucket: '1970-02-01' }]);
    });

    it('should include private assets in the buckets in private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      await newBucketAssets(ctx, user.id);
      const auth = factory.auth({ user, session: { privateMode: true } });

      await expect(sut.getTimeBuckets(auth, {})).resolves.toEqual([{ count: 2, timeBucket: '1970-02-01' }]);
    });

    it('should exclude private assets from a bucket outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { publicAsset } = await newBucketAssets(ctx, user.id);
      const auth = factory.auth({ user, session: { privateMode: false } });

      const response = JSON.parse(await sut.getTimeBucket(auth, { timeBucket: '1970-02-01' }));
      expect(response).toEqual(expect.objectContaining({ id: [publicAsset.id], isPrivate: [false] }));
    });

    it('should include private assets in a bucket in private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { publicAsset, privateAsset } = await newBucketAssets(ctx, user.id);
      const auth = factory.auth({ user, session: { privateMode: true } });

      const response = JSON.parse(await sut.getTimeBucket(auth, { timeBucket: '1970-02-01' }));
      expect(response).toEqual(
        expect.objectContaining({ id: [privateAsset.id, publicAsset.id], isPrivate: [true, false] }),
      );
    });

    it('should return only private assets when isPrivate is requested', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { privateAsset } = await newBucketAssets(ctx, user.id);
      const auth = factory.auth({ user, session: { privateMode: true } });

      await expect(sut.getTimeBuckets(auth, { isPrivate: true })).resolves.toEqual([
        { count: 1, timeBucket: '1970-02-01' },
      ]);
      const response = JSON.parse(await sut.getTimeBucket(auth, { timeBucket: '1970-02-01', isPrivate: true }));
      expect(response).toEqual(expect.objectContaining({ id: [privateAsset.id], isPrivate: [true] }));
    });

    it('should require private mode for private buckets', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      await newBucketAssets(ctx, user.id);
      const auth = factory.auth({ user, session: { privateMode: false } });

      await expect(sut.getTimeBuckets(auth, { isPrivate: true })).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(sut.getTimeBucket(auth, { timeBucket: '1970-02-01', isPrivate: true })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('should reject private buckets with partners', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user, session: { privateMode: true } });

      const response = sut.getTimeBuckets(auth, {
        isPrivate: true,
        withPartners: true,
        visibility: AssetVisibility.Timeline,
      });
      await expect(response).rejects.toBeInstanceOf(BadRequestException);
      await expect(response).rejects.toThrow('withPartners is not supported for private assets');
    });

    it("should never return a partner's private asset", async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });
      const { publicAsset } = await newBucketAssets(ctx, partner.id);

      for (const privateMode of [false, true]) {
        const auth = factory.auth({ user, session: { privateMode } });
        const options = { withPartners: true, visibility: AssetVisibility.Timeline };

        await expect(sut.getTimeBuckets(auth, options)).resolves.toEqual([{ count: 1, timeBucket: '1970-02-01' }]);
        const response = JSON.parse(await sut.getTimeBucket(auth, { ...options, timeBucket: '1970-02-01' }));
        expect(response).toEqual(expect.objectContaining({ id: [publicAsset.id] }));

        await expect(sut.getTimeBuckets(auth, { userId: partner.id })).resolves.toEqual([
          { count: 1, timeBucket: '1970-02-01' },
        ]);
      }
    });

    it('should hide private assets from the trash outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        localDateTime: new Date('1970-02-12'),
        deletedAt: new Date(),
        isPrivate: true,
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      const auth = factory.auth({ user, session: { privateMode: false } });
      await expect(sut.getTimeBuckets(auth, { isTrashed: true })).resolves.toEqual([]);
      const response = JSON.parse(await sut.getTimeBucket(auth, { timeBucket: '1970-02-01', isTrashed: true }));
      expect(response).toEqual(expect.objectContaining({ id: [] }));

      const privateAuth = factory.auth({ user, session: { privateMode: true } });
      await expect(sut.getTimeBuckets(privateAuth, { isTrashed: true })).resolves.toEqual([
        { count: 1, timeBucket: '1970-02-01' },
      ]);
      const privateResponse = JSON.parse(
        await sut.getTimeBucket(privateAuth, { timeBucket: '1970-02-01', isTrashed: true }),
      );
      expect(privateResponse).toEqual(expect.objectContaining({ id: [asset.id], isTrashed: [true] }));
    });

    it('should hide the buckets of a private album outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { publicAsset, privateAsset } = await newBucketAssets(ctx, user.id);
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [publicAsset.id, privateAsset.id]);
      const { album: plainAlbum } = await ctx.newAlbum({ ownerId: user.id }, [publicAsset.id]);

      const auth = factory.auth({ user, session: { privateMode: false } });
      await expect(sut.getTimeBuckets(auth, { albumId: album.id })).rejects.toThrow(
        'Not found or no album.read access',
      );
      await expect(sut.getTimeBucket(auth, { albumId: album.id, timeBucket: '1970-02-01' })).rejects.toThrow(
        'Not found or no album.read access',
      );
      // an album without private assets is unaffected
      await expect(sut.getTimeBuckets(auth, { albumId: plainAlbum.id })).resolves.toEqual([
        { count: 1, timeBucket: '1970-02-01' },
      ]);

      const privateAuth = factory.auth({ user, session: { privateMode: true } });
      await expect(sut.getTimeBuckets(privateAuth, { albumId: album.id })).resolves.toEqual([
        { count: 2, timeBucket: '1970-02-01' },
      ]);
      const response = JSON.parse(
        await sut.getTimeBucket(privateAuth, { albumId: album.id, timeBucket: '1970-02-01' }),
      );
      expect(response.id.sort()).toEqual([publicAsset.id, privateAsset.id].sort());
    });

    it('should hide the buckets of a private album from a co-viewer outside private mode', async () => {
      const { sut, ctx } = setup();
      const { album, owner, sharedWith, asset } = await ctx.newSharedAlbum();
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      const { privateAsset } = await newBucketAssets(ctx, owner.id);
      await ctx.newAlbumAsset({ albumId: album.id, assetId: privateAsset.id });

      await expect(sut.getTimeBuckets(factory.auth({ user: sharedWith }), { albumId: album.id })).rejects.toThrow(
        'Not found or no album.read access',
      );
      const buckets = await sut.getTimeBuckets(factory.auth({ user: sharedWith, session: { privateMode: true } }), {
        albumId: album.id,
      });
      expect(buckets.reduce((sum, { count }) => sum + count, 0)).toBe(2);
    });
  });

  describe('automatic stacks', () => {
    it('should collapse manual and automatic stacks by default', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { manual, auto, manualPrimary, autoPrimary, single } = await newStackedAssets(ctx, user.id);
      const auth = factory.auth({ user });

      await expect(sut.getTimeBuckets(auth, { withStacked: true })).resolves.toEqual([
        { count: 3, timeBucket: '1970-02-01' },
      ]);

      const response = JSON.parse(await sut.getTimeBucket(auth, { timeBucket: '1970-02-01', withStacked: true }));
      expect(response.id).toEqual([single.id, autoPrimary.id, manualPrimary.id]);
      expect(response.stack).toEqual([null, [auto.id, '2'], [manual.id, '2']]);
    });

    it('should list the assets of automatic stacks individually when withAutoStacked is false', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { manual, manualPrimary, autoPrimary, autoChild, single } = await newStackedAssets(ctx, user.id);
      const auth = factory.auth({ user });

      await expect(sut.getTimeBuckets(auth, { withStacked: true, withAutoStacked: false })).resolves.toEqual([
        { count: 4, timeBucket: '1970-02-01' },
      ]);

      const response = JSON.parse(
        await sut.getTimeBucket(auth, { timeBucket: '1970-02-01', withStacked: true, withAutoStacked: false }),
      );
      expect(response.id).toEqual([single.id, autoChild.id, autoPrimary.id, manualPrimary.id]);
      expect(response.stack).toEqual([null, null, null, [manual.id, '2']]);
    });

    it('should ignore withAutoStacked without withStacked', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      await newStackedAssets(ctx, user.id);
      const auth = factory.auth({ user });

      await expect(sut.getTimeBuckets(auth, { withAutoStacked: false })).resolves.toEqual([
        { count: 5, timeBucket: '1970-02-01' },
      ]);
      const response = JSON.parse(await sut.getTimeBucket(auth, { timeBucket: '1970-02-01', withAutoStacked: false }));
      expect(response.id).toHaveLength(5);
      expect(response).not.toHaveProperty('stack');
    });
  });
});
