import { Kysely } from 'kysely';
import { AssetType } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PartnerRepository } from 'src/repositories/partner.repository';
import { VideoBookmarkRepository } from 'src/repositories/video-bookmark.repository';
import { DB } from 'src/schema';
import { VideoBookmarkService } from 'src/services/video-bookmark.service';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(VideoBookmarkService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AssetRepository, PartnerRepository, VideoBookmarkRepository],
    mock: [LoggingRepository],
  });
};

const newVideo = async (ctx: ReturnType<typeof setup>['ctx'], ownerId: string, duration: number | null) => {
  const { asset } = await ctx.newAsset({ ownerId, type: AssetType.Video, duration });
  return asset;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(VideoBookmarkService.name, () => {
  it('should create, list in time order, update and delete bookmarks', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
    const auth = factory.auth({ user });

    const late = await sut.create(auth, { assetId: asset.id, time: 90_000, label: 'Cake' });
    const early = await sut.create(auth, { assetId: asset.id, time: 5000 });
    expect(early.label).toBe('');

    await expect(sut.getAll(auth, { assetId: asset.id })).resolves.toEqual([
      expect.objectContaining({ id: early.id, time: 5000 }),
      expect.objectContaining({ id: late.id, time: 90_000, label: 'Cake' }),
    ]);

    const updated = await sut.update(auth, early.id, { label: 'Candles' });
    expect(updated).toEqual(expect.objectContaining({ id: early.id, time: 5000, label: 'Candles' }));
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(early.updatedAt).getTime());

    await sut.delete(auth, late.id);
    await expect(sut.getAll(auth, { assetId: asset.id })).resolves.toEqual([expect.objectContaining({ id: early.id })]);
  });

  it('should keep bookmarks personal on a video shared with a partner', async () => {
    const { sut, ctx } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: partner } = await ctx.newUser();
    await ctx.newPartner({ sharedById: owner.id, sharedWithId: partner.id });
    const { asset } = await ctx.newAsset({ ownerId: owner.id, type: AssetType.Video });
    const ownerAuth = factory.auth({ user: owner });
    const partnerAuth = factory.auth({ user: partner });

    const mine = await sut.create(ownerAuth, { assetId: asset.id, time: 1000, label: 'Owner' });
    const theirs = await sut.create(partnerAuth, { assetId: asset.id, time: 2000, label: 'Partner' });

    await expect(sut.getAll(ownerAuth, { assetId: asset.id })).resolves.toEqual([
      expect.objectContaining({ id: mine.id }),
    ]);
    await expect(sut.getAll(partnerAuth, { assetId: asset.id })).resolves.toEqual([
      expect.objectContaining({ id: theirs.id }),
    ]);
    await expect(sut.update(partnerAuth, mine.id, { label: 'Taken' })).rejects.toThrow();
    await expect(sut.delete(ownerAuth, theirs.id)).rejects.toThrow();
  });

  it('should refuse videos the user cannot view and photos', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { user: stranger } = await ctx.newUser();
    const { asset: video } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
    const { asset: photo } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });

    await expect(sut.create(factory.auth({ user: stranger }), { assetId: video.id, time: 0 })).rejects.toThrow();
    await expect(sut.getAll(factory.auth({ user: stranger }), { assetId: video.id })).rejects.toThrow();
    await expect(sut.create(factory.auth({ user }), { assetId: photo.id, time: 0 })).rejects.toThrow(
      'Only videos can have bookmarks',
    );
  });

  it('should hide bookmarks of private videos while private mode is locked', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, isPrivate: true });
    const unlocked = factory.auth({ user, session: { privateMode: true } });
    const locked = factory.auth({ user });

    const bookmark = await sut.create(unlocked, { assetId: asset.id, time: 3000 });

    await expect(sut.getAll(locked, { assetId: asset.id })).rejects.toThrow();
    await expect(sut.update(locked, bookmark.id, { label: 'Peek' })).rejects.toThrow();
    await expect(sut.getAll(unlocked, { assetId: asset.id })).resolves.toHaveLength(1);
  });

  it('should delete bookmarks with their video', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
    await sut.create(factory.auth({ user }), { assetId: asset.id, time: 0 });

    await ctx.database.deleteFrom('asset').where('id', '=', asset.id).execute();

    await expect(
      ctx.database.selectFrom('video_bookmark').selectAll().where('assetId', '=', asset.id).execute(),
    ).resolves.toEqual([]);
  });

  describe('stacked copies', () => {
    it('should share bookmarks between stacked videos whose lengths match within a second', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const video = await newVideo(ctx, user.id, 439_142);
      const copy = await newVideo(ctx, user.id, 439_041);
      const short = await newVideo(ctx, user.id, 300_000);
      const loose = await newVideo(ctx, user.id, 439_142);
      await ctx.newStack({ ownerId: user.id }, [video.id, copy.id, short.id]);

      const onVideo = await sut.create(auth, { assetId: video.id, time: 60_000 });
      const onCopy = await sut.create(auth, { assetId: copy.id, time: 10_000, label: 'Cake' });
      const onShort = await sut.create(auth, { assetId: short.id, time: 20_000 });
      const onLoose = await sut.create(auth, { assetId: loose.id, time: 30_000 });

      const shared = [
        expect.objectContaining({ id: onCopy.id, assetId: copy.id, label: 'Cake' }),
        expect.objectContaining({ id: onVideo.id, assetId: video.id }),
      ];
      await expect(sut.getAll(auth, { assetId: video.id })).resolves.toEqual(shared);
      await expect(sut.getAll(auth, { assetId: copy.id })).resolves.toEqual(shared);
      await expect(sut.getAll(auth, { assetId: short.id })).resolves.toEqual([
        expect.objectContaining({ id: onShort.id }),
      ]);
      await expect(sut.getAll(auth, { assetId: loose.id })).resolves.toEqual([
        expect.objectContaining({ id: onLoose.id }),
      ]);
    });

    it('should stop sharing once the videos are unstacked or a copy is trashed', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const video = await newVideo(ctx, user.id, 439_142);
      const copy = await newVideo(ctx, user.id, 439_041);
      const trashed = await newVideo(ctx, user.id, 439_100);
      const { stack } = await ctx.newStack({ ownerId: user.id }, [video.id, copy.id, trashed.id]);
      const onCopy = await sut.create(auth, { assetId: copy.id, time: 10_000 });
      await sut.create(auth, { assetId: trashed.id, time: 20_000 });

      await ctx.softDeleteAsset(trashed.id);
      await expect(sut.getAll(auth, { assetId: video.id })).resolves.toEqual([
        expect.objectContaining({ id: onCopy.id }),
      ]);

      await ctx.database.deleteFrom('stack').where('id', '=', stack.id).execute();
      await expect(sut.getAll(auth, { assetId: video.id })).resolves.toEqual([]);
      await expect(sut.getAll(auth, { assetId: copy.id })).resolves.toEqual([
        expect.objectContaining({ id: onCopy.id }),
      ]);
    });

    it('should list a moment bookmarked on two copies once and keep bookmarks personal', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: owner.id, sharedWithId: partner.id });
      const ownerAuth = factory.auth({ user: owner });
      const partnerAuth = factory.auth({ user: partner });
      const video = await newVideo(ctx, owner.id, 439_142);
      const copy = await newVideo(ctx, owner.id, 439_041);
      await ctx.newStack({ ownerId: owner.id }, [video.id, copy.id]);

      const onVideo = await sut.create(ownerAuth, { assetId: video.id, time: 10_000 });
      const onCopy = await sut.create(ownerAuth, { assetId: copy.id, time: 10_400 });
      const partnerOnCopy = await sut.create(partnerAuth, { assetId: copy.id, time: 50_000 });

      await expect(sut.getAll(ownerAuth, { assetId: video.id })).resolves.toEqual([
        expect.objectContaining({ id: onVideo.id }),
      ]);
      await expect(sut.getAll(ownerAuth, { assetId: copy.id })).resolves.toEqual([
        expect.objectContaining({ id: onCopy.id }),
      ]);
      await expect(sut.getAll(partnerAuth, { assetId: video.id })).resolves.toEqual([
        expect.objectContaining({ id: partnerOnCopy.id, assetId: copy.id }),
      ]);
      await expect(sut.delete(ownerAuth, partnerOnCopy.id)).rejects.toThrow();
    });

    it('should edit and delete a bookmark from a stacked copy of its video', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const video = await newVideo(ctx, user.id, 439_142);
      const copy = await newVideo(ctx, user.id, 439_041);
      await ctx.newStack({ ownerId: user.id }, [video.id, copy.id]);
      await sut.create(auth, { assetId: video.id, time: 10_000 });

      const [listed] = await sut.getAll(auth, { assetId: copy.id });
      await expect(sut.update(auth, listed.id, { label: 'Candles' })).resolves.toEqual(
        expect.objectContaining({ id: listed.id, assetId: video.id, label: 'Candles' }),
      );
      await sut.delete(auth, listed.id);

      await expect(sut.getAll(auth, { assetId: video.id })).resolves.toEqual([]);
    });
  });
});
