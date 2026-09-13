import { AssetMediaStatus, type AssetMediaResponseDto, type UserAdminResponseDto } from '@immich/sdk';
import { modalManager } from '@immich/ui';
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
    const album = albumFactory.build({ id: 'album-1', shared: true });
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

      expect(modalManager.showDialog).toHaveBeenCalledExactlyOnceWith({
        title: 'private_mode',
        prompt: 'share_private_assets_album_confirmation',
        confirmText: 'add',
      });
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

    it('does not ask when the album is not shared', async () => {
      sdkMock.getAlbumInfo.mockResolvedValue(albumFactory.build({ id: album.id, shared: false, hasSharedLink: false }));
      vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 200, data: duplicateResponse });

      await fileUploadHandler({ files: [mockFile], albumId: album.id });

      expect(sdkMock.getAssetInfo).not.toHaveBeenCalled();
      expect(modalManager.showDialog).not.toHaveBeenCalled();
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledOnce();
    });
  });
});
