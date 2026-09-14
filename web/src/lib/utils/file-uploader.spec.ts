import { AssetMediaStatus, type AssetMediaResponseDto, type UserAdminResponseDto } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import { mdiLockOutline } from '@mdi/js';
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { uploadManager } from '$lib/managers/upload-manager.svelte';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState } from '$lib/types';
import * as utils from '$lib/utils';
import { albumFactory } from '@test-data/factories/album-factory';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { fileUploadHandler } from './file-uploader';

vi.mock('@immich/ui', async (originalImport) => {
  const module = await originalImport<typeof import('@immich/ui')>();
  return {
    ...module,
    modalManager: {
      show: vi.fn(),
      showDialog: vi.fn(),
    },
  };
});

vi.mock('$lib/utils/i18n', () => ({
  getFormatter: () => Promise.resolve((key: string) => key),
  getPreferredLocale: vi.fn(),
}));

describe('fileUploader error handling', () => {
  const mockFile = new File(['content'], 'test.jpg', { type: 'image/jpeg' });
  const mockUserObject = { id: 'user-123', email: 'test@example.com' } as UserAdminResponseDto;
  const mockError = new Error('Upload failed');
  const mockUploadResponse = { id: 'mock-id', status: AssetMediaStatus.Created } as AssetMediaResponseDto;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(uploadManager, 'getExtensions').mockReturnValue(['.jpg']);
    uploadAssetsStore.reset();
    authManager.reset();
  });

  for (const [name, mockUser] of [
    ['logged-in users', true],
    ['anonymous users', false],
  ] as const) {
    describe(`for ${name}`, () => {
      beforeEach(() => {
        if (mockUser) {
          authManager.setUser(mockUserObject);
        }
      });

      it(`should transition successful uploads to done`, async () => {
        vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 200, data: mockUploadResponse });

        await fileUploadHandler({ files: [mockFile] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.DONE);
      });

      it('should capture errors', async () => {
        vi.spyOn(utils, 'uploadRequest').mockRejectedValue(mockError);

        await fileUploadHandler({ files: [mockFile] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.ERROR);
      });
    });
  }

  it('should suppress errors on logout', async () => {
    authManager.setUser(mockUserObject);
    authManager.setPreferences(preferencesFactory.build());
    vi.spyOn(utils, 'uploadRequest').mockImplementationOnce(() => {
      authManager.reset();
      return Promise.reject(mockError);
    });

    await fileUploadHandler({ files: [mockFile] });

    const items = get(uploadAssetsStore);
    expect(items.length).toBe(1);
    expect(items[0].state).toBe(UploadState.STARTED);
  });

  describe('uploading into a shared album', () => {
    const album = albumFactory.build({ id: 'album-1', shared: true, isPrivate: false, assetCount: 2 });
    const duplicateResponse = { id: 'existing-asset', status: AssetMediaStatus.Duplicate } as AssetMediaResponseDto;

    beforeEach(() => {
      authManager.setUser(mockUserObject);
      sdkMock.getAlbumInfo.mockResolvedValue(album);
      sdkMock.addAssetsToAlbum.mockResolvedValue([]);
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);
    });

    it('asks for confirmation and forwards confirmPrivate when the upload resolves to a private asset', async () => {
      vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 200, data: duplicateResponse });
      sdkMock.getAssetInfo.mockResolvedValue(assetFactory.build({ id: 'existing-asset', isPrivate: true }));

      await fileUploadHandler({ files: [mockFile], albumId: album.id });

      expect(modalManager.showDialog).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          prompt: 'add_to_album_private_prompt add_to_album_shared_private_prompt',
          confirmText: 'add_to_album_private_confirm',
        }),
      );
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: album.id, albumAddAssetsDto: { ids: ['existing-asset'], confirmPrivate: true } }),
      );
    });

    it('does not ask for a new upload', async () => {
      vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 200, data: mockUploadResponse });

      await fileUploadHandler({ files: [mockFile], albumId: album.id });

      expect(sdkMock.getAssetInfo).not.toHaveBeenCalled();
      expect(modalManager.showDialog).not.toHaveBeenCalled();
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ albumAddAssetsDto: { ids: [mockUploadResponse.id], confirmPrivate: undefined } }),
      );
    });

    it('asks about a public album turning private even when it is not shared', async () => {
      sdkMock.getAlbumInfo.mockResolvedValue(
        albumFactory.build({ id: album.id, shared: false, hasSharedLink: false, isPrivate: false, assetCount: 2 }),
      );
      sdkMock.getAssetInfo.mockResolvedValue(assetFactory.build({ id: 'existing-asset', isPrivate: true }));
      vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 200, data: duplicateResponse });

      await fileUploadHandler({ files: [mockFile], albumId: album.id });

      expect(modalManager.showDialog).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ prompt: 'add_to_album_private_prompt' }),
      );
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ albumAddAssetsDto: { ids: ['existing-asset'], confirmPrivate: true } }),
      );
    });
  });

  describe('uploading into a private album', () => {
    const privateAlbum = albumFactory.build({ id: 'album-2', albumName: 'Secret', isPrivate: true, assetCount: 1 });
    const otherFile = new File(['more'], 'other.jpg', { type: 'image/jpeg' });

    beforeEach(() => {
      authManager.setUser(mockUserObject);
      sdkMock.getAlbumInfo.mockResolvedValue(privateAlbum);
      sdkMock.addAssetsToAlbum.mockResolvedValue([]);
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);
    });

    it('asks once for the whole batch and then uploads every file', async () => {
      const upload = vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 200, data: mockUploadResponse });

      await fileUploadHandler({ files: [mockFile, otherFile], albumId: privateAlbum.id });

      expect(modalManager.showDialog).toHaveBeenCalledExactlyOnceWith({
        title: 'private_mode',
        prompt: 'upload_to_private_album_prompt',
        confirmText: 'upload_to_private_album_confirm',
        confirmColor: 'primary',
        icon: mdiLockOutline,
      });
      expect(upload).toHaveBeenCalledTimes(2);
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledTimes(2);
    });

    it('uploads nothing when the batch is cancelled', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(false);
      const upload = vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 200, data: mockUploadResponse });

      const result = await fileUploadHandler({ files: [mockFile, otherFile], albumId: privateAlbum.id });

      expect(result).toEqual([]);
      expect(upload).not.toHaveBeenCalled();
      expect(sdkMock.addAssetsToAlbum).not.toHaveBeenCalled();
      expect(get(uploadAssetsStore)).toHaveLength(0);
    });

    it('does not ask for a public album', async () => {
      sdkMock.getAlbumInfo.mockResolvedValue(albumFactory.build({ id: 'album-3', isPrivate: false, assetCount: 1 }));
      vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 200, data: mockUploadResponse });

      await fileUploadHandler({ files: [mockFile], albumId: 'album-3' });

      expect(modalManager.showDialog).not.toHaveBeenCalled();
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledOnce();
    });

    it('folds the shared warning into the batch dialog and does not ask again per file', async () => {
      sdkMock.getAlbumInfo.mockResolvedValue(
        albumFactory.build({ id: 'album-4', albumName: 'Secret', isPrivate: true, shared: true, assetCount: 1 }),
      );
      // the upload resolves to an existing private asset, which would otherwise trigger the shared-album dialog
      vi.spyOn(utils, 'uploadRequest').mockResolvedValue({
        status: 200,
        data: { id: 'existing-asset', status: AssetMediaStatus.Duplicate } as AssetMediaResponseDto,
      });
      sdkMock.getAssetInfo.mockResolvedValue(assetFactory.build({ id: 'existing-asset', isPrivate: true }));

      await fileUploadHandler({ files: [mockFile], albumId: 'album-4' });

      expect(modalManager.showDialog).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ prompt: 'upload_to_private_album_prompt add_to_album_shared_private_prompt' }),
      );
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ albumAddAssetsDto: { ids: ['existing-asset'], confirmPrivate: true } }),
      );
    });
  });
});
