import { BadRequestException } from '@nestjs/common';
import { mapVideoBookmark } from 'src/dtos/video-bookmark.dto';
import { AssetType } from 'src/enum';
import { VideoBookmarkService } from 'src/services/video-bookmark.service';
import { AssetFactory } from 'test/factories/asset.factory';
import { AuthFactory } from 'test/factories/auth.factory';
import { newDate, newUuid } from 'test/small.factory';
import { newTestService, ServiceMocks } from 'test/utils';

const newBookmark = (dto: { assetId?: string; userId?: string; time?: number; label?: string } = {}) => ({
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

      expect(mocks.videoBookmark.getByAssetId).not.toHaveBeenCalled();
    });

    it('should only return the bookmarks of the current user', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.create({ type: AssetType.Video });
      const bookmark = newBookmark({ assetId: asset.id, userId: auth.user.id });
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([asset.id]));
      mocks.videoBookmark.getByAssetId.mockResolvedValue([bookmark]);

      await expect(sut.getAll(auth, { assetId: asset.id })).resolves.toEqual([mapVideoBookmark(bookmark)]);

      expect(mocks.videoBookmark.getByAssetId).toHaveBeenCalledWith(asset.id, auth.user.id);
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
      mocks.asset.getById.mockResolvedValue(asset);

      await expect(sut.create(auth, { assetId: asset.id, time: 0 })).rejects.toThrow('Only videos can have bookmarks');

      expect(mocks.videoBookmark.create).not.toHaveBeenCalled();
    });

    it('should bookmark a video shared with the user for that user', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.create({ type: AssetType.Video });
      const bookmark = newBookmark({ assetId: asset.id, userId: auth.user.id, time: 83_500, label: 'Goal' });
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(asset);
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
      mocks.asset.getById.mockResolvedValue(asset);
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
  });
});
