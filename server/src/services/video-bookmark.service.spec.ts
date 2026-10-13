import { BadRequestException } from '@nestjs/common';
import { mapVideoBookmark } from 'src/dtos/video-bookmark.dto';
import { AssetType } from 'src/enum';
import { VideoBookmarkService } from 'src/services/video-bookmark.service';
import { AssetFactory } from 'test/factories/asset.factory';
import { AuthFactory } from 'test/factories/auth.factory';
import { getForAsset } from 'test/mappers';
import { newDate, newUuid } from 'test/small.factory';
import { newTestService, ServiceMocks } from 'test/utils';

const newBookmark = (
  dto: { assetId?: string; userId?: string; time?: number; label?: string; createdAt?: Date } = {},
) => ({
  id: newUuid(),
  assetId: newUuid(),
  userId: newUuid(),
  time: 1000,
  label: '',
  createdAt: newDate(),
  updatedAt: newDate(),
  updateId: newUuid(),
  ...dto,
});

describe(VideoBookmarkService.name, () => {
  let sut: VideoBookmarkService;
  let mocks: ServiceMocks;

  /** The user owns exactly these assets */
  const ownAssets = (...ids: string[]) =>
    mocks.access.asset.checkOwnerAccess.mockImplementation((_userId, assetIds) =>
      Promise.resolve(new Set([...assetIds].filter((id) => ids.includes(id)))),
    );

  beforeEach(() => {
    ({ sut, mocks } = newTestService(VideoBookmarkService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getAll', () => {
    it('should require read access to the video', async () => {
      const auth = AuthFactory.create();

      await expect(sut.getAll(auth, { assetId: newUuid() })).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.videoBookmark.getStackVideos).not.toHaveBeenCalled();
      expect(mocks.videoBookmark.getByAssetIds).not.toHaveBeenCalled();
    });

    it('should only return the bookmarks of the current user', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.create({ type: AssetType.Video });
      const bookmark = newBookmark({ assetId: asset.id, userId: auth.user.id });
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([asset.id]));
      mocks.videoBookmark.getStackVideos.mockResolvedValue([]);
      mocks.videoBookmark.getByAssetIds.mockResolvedValue([bookmark]);

      await expect(sut.getAll(auth, { assetId: asset.id })).resolves.toEqual([mapVideoBookmark(bookmark)]);

      expect(mocks.videoBookmark.getByAssetIds).toHaveBeenCalledWith([asset.id], auth.user.id);
    });

    describe('stacked copies', () => {
      const videoId = newUuid();
      const copyId = newUuid();
      const otherCopyId = newUuid();
      const shortId = newUuid();

      it('should share the bookmarks of a stacked video whose length matches within a second', async () => {
        const auth = AuthFactory.create();
        ownAssets(videoId, copyId, shortId);
        mocks.videoBookmark.getStackVideos.mockResolvedValue([
          { id: videoId, duration: 439_142 },
          { id: copyId, duration: 439_041 },
          { id: shortId, duration: 300_000 },
        ]);
        const own = newBookmark({ assetId: videoId, userId: auth.user.id, time: 60_000 });
        const shared = newBookmark({ assetId: copyId, userId: auth.user.id, time: 10_000, label: 'Cake' });
        mocks.videoBookmark.getByAssetIds.mockResolvedValue([shared, own]);

        await expect(sut.getAll(auth, { assetId: videoId })).resolves.toEqual([
          mapVideoBookmark(shared),
          mapVideoBookmark(own),
        ]);

        // the 5 minute video in the same stack is another video and keeps its bookmarks to itself
        expect(mocks.videoBookmark.getByAssetIds).toHaveBeenCalledWith([videoId, copyId], auth.user.id);
      });

      it('should share both ways', async () => {
        const auth = AuthFactory.create();
        ownAssets(videoId, copyId, shortId);
        mocks.videoBookmark.getStackVideos.mockResolvedValue([
          { id: videoId, duration: 439_142 },
          { id: copyId, duration: 439_041 },
          { id: shortId, duration: 300_000 },
        ]);
        mocks.videoBookmark.getByAssetIds.mockResolvedValue([]);

        await sut.getAll(auth, { assetId: copyId });
        await sut.getAll(auth, { assetId: shortId });

        expect(mocks.videoBookmark.getByAssetIds).toHaveBeenNthCalledWith(1, [copyId, videoId], auth.user.id);
        expect(mocks.videoBookmark.getByAssetIds).toHaveBeenNthCalledWith(2, [shortId], auth.user.id);
      });

      it('should share up to a second of difference and not beyond', async () => {
        const auth = AuthFactory.create();
        ownAssets(videoId, copyId, shortId);
        mocks.videoBookmark.getStackVideos.mockResolvedValue([
          { id: videoId, duration: 439_142 },
          { id: shortId, duration: 438_141 },
          { id: copyId, duration: 440_142 },
        ]);
        mocks.videoBookmark.getByAssetIds.mockResolvedValue([]);

        await sut.getAll(auth, { assetId: videoId });

        expect(mocks.videoBookmark.getByAssetIds).toHaveBeenCalledWith([videoId, copyId], auth.user.id);
      });

      it('should never share between videos that are not stacked', async () => {
        const auth = AuthFactory.create();
        ownAssets(videoId);
        mocks.videoBookmark.getStackVideos.mockResolvedValue([]);
        mocks.videoBookmark.getByAssetIds.mockResolvedValue([]);

        await sut.getAll(auth, { assetId: videoId });

        expect(mocks.videoBookmark.getStackVideos).toHaveBeenCalledWith(videoId);
        expect(mocks.videoBookmark.getByAssetIds).toHaveBeenCalledWith([videoId], auth.user.id);
      });

      it('should not share when a length is unknown', async () => {
        const auth = AuthFactory.create();
        ownAssets(videoId, copyId, otherCopyId);
        mocks.videoBookmark.getByAssetIds.mockResolvedValue([]);

        mocks.videoBookmark.getStackVideos.mockResolvedValue([
          { id: videoId, duration: null },
          { id: copyId, duration: null },
        ]);
        await sut.getAll(auth, { assetId: videoId });

        mocks.videoBookmark.getStackVideos.mockResolvedValue([
          { id: videoId, duration: 439_142 },
          { id: copyId, duration: null },
          { id: otherCopyId, duration: 0 },
        ]);
        await sut.getAll(auth, { assetId: videoId });

        expect(mocks.videoBookmark.getByAssetIds).toHaveBeenNthCalledWith(1, [videoId], auth.user.id);
        expect(mocks.videoBookmark.getByAssetIds).toHaveBeenNthCalledWith(2, [videoId], auth.user.id);
      });

      it('should leave out a copy the user cannot view', async () => {
        const auth = AuthFactory.create();
        ownAssets(videoId);
        mocks.videoBookmark.getStackVideos.mockResolvedValue([
          { id: videoId, duration: 439_142 },
          { id: copyId, duration: 439_041 },
        ]);
        mocks.videoBookmark.getByAssetIds.mockResolvedValue([]);

        await sut.getAll(auth, { assetId: videoId });

        expect(mocks.access.asset.checkOwnerAccess).toHaveBeenLastCalledWith(
          auth.user.id,
          new Set([copyId]),
          expect.anything(),
        );
        expect(mocks.videoBookmark.getByAssetIds).toHaveBeenCalledWith([videoId], auth.user.id);
      });

      it('should list a moment bookmarked on two copies once, the one on the video itself first', async () => {
        const auth = AuthFactory.create();
        ownAssets(videoId, copyId, otherCopyId);
        mocks.videoBookmark.getStackVideos.mockResolvedValue([
          { id: videoId, duration: 439_142 },
          { id: copyId, duration: 439_041 },
          { id: otherCopyId, duration: 439_500 },
        ]);
        const earlier = new Date('2026-01-01T00:00:00.000Z');
        const later = new Date('2026-02-01T00:00:00.000Z');
        const userId = auth.user.id;
        // the same moment on the video and on a copy: the one on the video wins, even though it came later
        const own = newBookmark({ assetId: videoId, userId, time: 10_000, createdAt: later });
        const ownDuplicate = newBookmark({ assetId: copyId, userId, time: 10_400, createdAt: earlier });
        // two bookmarks close together on the video itself are both kept
        const ownClose = newBookmark({ assetId: videoId, userId, time: 10_300, createdAt: later });
        // the same moment on two copies: the earliest created wins
        const first = newBookmark({ assetId: otherCopyId, userId, time: 30_450, createdAt: earlier });
        const second = newBookmark({ assetId: copyId, userId, time: 30_000, createdAt: later });
        // further apart than half a second: both kept
        const apart = newBookmark({ assetId: copyId, userId, time: 60_000, createdAt: later });
        const apartOwn = newBookmark({ assetId: videoId, userId, time: 60_501, createdAt: later });
        mocks.videoBookmark.getByAssetIds.mockResolvedValue([
          own,
          ownClose,
          ownDuplicate,
          second,
          first,
          apart,
          apartOwn,
        ]);

        await expect(sut.getAll(auth, { assetId: videoId })).resolves.toEqual(
          [own, ownClose, first, apart, apartOwn].map((bookmark) => mapVideoBookmark(bookmark)),
        );
      });
    });
  });

  describe('create', () => {
    it('should require read access to the video', async () => {
      const auth = AuthFactory.create();

      await expect(sut.create(auth, { assetId: newUuid(), time: 0 })).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.videoBookmark.create).not.toHaveBeenCalled();
    });

    it('should refuse photos', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.create({ ownerId: auth.user.id, type: AssetType.Image });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await expect(sut.create(auth, { assetId: asset.id, time: 0 })).rejects.toThrow('Only videos can have bookmarks');

      expect(mocks.videoBookmark.create).not.toHaveBeenCalled();
    });

    it('should bookmark a video shared with the user for that user', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.create({ type: AssetType.Video });
      const bookmark = newBookmark({ assetId: asset.id, userId: auth.user.id, time: 83_500, label: 'Goal' });
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.videoBookmark.create.mockResolvedValue(bookmark);

      await expect(sut.create(auth, { assetId: asset.id, time: 83_500, label: 'Goal' })).resolves.toEqual(
        mapVideoBookmark(bookmark),
      );

      expect(mocks.videoBookmark.create).toHaveBeenCalledWith({
        assetId: asset.id,
        userId: auth.user.id,
        time: 83_500,
        label: 'Goal',
      });
    });

    it('should store an empty label when none is given', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.create({ ownerId: auth.user.id, type: AssetType.Video });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.videoBookmark.create.mockResolvedValue(newBookmark({ assetId: asset.id, userId: auth.user.id }));

      await sut.create(auth, { assetId: asset.id, time: 1000 });

      expect(mocks.videoBookmark.create).toHaveBeenCalledWith(expect.objectContaining({ label: '' }));
    });
  });

  describe('update', () => {
    it('should refuse bookmarks of other users', async () => {
      const auth = AuthFactory.create();

      await expect(sut.update(auth, newUuid(), { label: 'Mine now' })).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.videoBookmark.update).not.toHaveBeenCalled();
    });

    it('should refuse a bookmark on a video the user can no longer view', async () => {
      const auth = AuthFactory.create();
      const bookmark = newBookmark({ userId: auth.user.id });
      mocks.access.videoBookmark.checkOwnerAccess.mockResolvedValue(new Set([bookmark.id]));
      mocks.videoBookmark.get.mockResolvedValue(bookmark);

      await expect(sut.update(auth, bookmark.id, { label: 'Hidden' })).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.videoBookmark.update).not.toHaveBeenCalled();
    });

    it('should update the label and the position', async () => {
      const auth = AuthFactory.create();
      const bookmark = newBookmark({ userId: auth.user.id });
      const updated = { ...bookmark, time: 2000, label: 'Cake' };
      mocks.access.videoBookmark.checkOwnerAccess.mockResolvedValue(new Set([bookmark.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([bookmark.assetId]));
      mocks.videoBookmark.get.mockResolvedValue(bookmark);
      mocks.videoBookmark.update.mockResolvedValue(updated);

      await expect(sut.update(auth, bookmark.id, { time: 2000, label: 'Cake' })).resolves.toEqual(
        mapVideoBookmark(updated),
      );

      expect(mocks.videoBookmark.update).toHaveBeenCalledWith(bookmark.id, { time: 2000, label: 'Cake' });
    });
  });

  describe('delete', () => {
    it('should refuse bookmarks of other users', async () => {
      const auth = AuthFactory.create();

      await expect(sut.delete(auth, newUuid())).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.videoBookmark.delete).not.toHaveBeenCalled();
    });

    it('should delete the bookmark', async () => {
      const auth = AuthFactory.create();
      const bookmark = newBookmark({ userId: auth.user.id });
      mocks.access.videoBookmark.checkOwnerAccess.mockResolvedValue(new Set([bookmark.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([bookmark.assetId]));
      mocks.videoBookmark.get.mockResolvedValue(bookmark);
      mocks.videoBookmark.delete.mockResolvedValue();

      await sut.delete(auth, bookmark.id);

      expect(mocks.videoBookmark.delete).toHaveBeenCalledWith(bookmark.id);
    });

    it('should delete a bookmark listed on a stacked copy of its video', async () => {
      const auth = AuthFactory.create();
      const videoId = newUuid();
      const copyId = newUuid();
      ownAssets(videoId, copyId);
      mocks.videoBookmark.getStackVideos.mockResolvedValue([
        { id: videoId, duration: 439_142 },
        { id: copyId, duration: 439_041 },
      ]);
      const bookmark = newBookmark({ assetId: videoId, userId: auth.user.id, time: 5000 });
      mocks.videoBookmark.getByAssetIds.mockResolvedValue([bookmark]);
      mocks.access.videoBookmark.checkOwnerAccess.mockResolvedValue(new Set([bookmark.id]));
      mocks.videoBookmark.get.mockResolvedValue(bookmark);
      mocks.videoBookmark.delete.mockResolvedValue();

      const [listed] = await sut.getAll(auth, { assetId: copyId });
      expect(listed).toEqual(expect.objectContaining({ id: bookmark.id, assetId: videoId }));

      await sut.delete(auth, listed.id);

      expect(mocks.videoBookmark.delete).toHaveBeenCalledWith(bookmark.id);
    });

    it('should refuse a bookmark of another user on a stacked copy', async () => {
      const auth = AuthFactory.create();
      const copyId = newUuid();
      ownAssets(copyId);
      const bookmark = newBookmark({ assetId: copyId, time: 5000 });
      mocks.videoBookmark.get.mockResolvedValue(bookmark);

      await expect(sut.delete(auth, bookmark.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.access.videoBookmark.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([bookmark.id]));
      expect(mocks.videoBookmark.delete).not.toHaveBeenCalled();
    });
  });
});
