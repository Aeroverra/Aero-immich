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
});
