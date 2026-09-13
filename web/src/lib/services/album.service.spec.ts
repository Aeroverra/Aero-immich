import { modalManager } from '@immich/ui';
import { goto } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { addAssetsToAlbums, handleAddUsersToAlbum, handleAlbumPrivateModeChange } from '$lib/services/album.service';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
}));

vi.mock('@immich/ui', async (originalImport) => {
  const module = await originalImport<typeof import('@immich/ui')>();
  return {
    ...module,
    modalManager: {
      show: vi.fn(),
      showDialog: vi.fn(),
    },
    toastManager: {
      primary: vi.fn(),
    },
  };
});

vi.mock('$lib/utils/i18n', () => ({
  getFormatter: () => Promise.resolve((key: string) => key),
  getPreferredLocale: vi.fn(),
}));

describe('AlbumService', () => {
  describe('handleAddUsersToAlbum', () => {
    const users = userAdminFactory.buildList(2);

    beforeEach(() => {
      vi.clearAllMocks();
      sdkMock.addUsersToAlbum.mockResolvedValue(albumFactory.build());
    });

    it('adds users to a non-private album without asking', async () => {
      const album = albumFactory.build({ isPrivate: false });
      const onAlbumShare = vi.fn();
      const unsubscribe = eventManager.on({ AlbumShare: onAlbumShare });

      const result = await handleAddUsersToAlbum(album, users);

      expect(result).toBe(true);
      expect(modalManager.showDialog).not.toHaveBeenCalled();
      expect(sdkMock.addUsersToAlbum).toHaveBeenCalledExactlyOnceWith({
        id: album.id,
        addUsersDto: { albumUsers: users.map(({ id }) => ({ userId: id })), confirmPrivate: undefined },
      });
      expect(onAlbumShare).toHaveBeenCalledOnce();
      unsubscribe();
    });

    it('asks for confirmation and forwards confirmPrivate for a private album', async () => {
      const album = albumFactory.build({ isPrivate: true });
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);

      const result = await handleAddUsersToAlbum(album, users);

      expect(result).toBe(true);
      expect(modalManager.showDialog).toHaveBeenCalledExactlyOnceWith({
        title: 'private_mode',
        prompt: 'share_private_album_confirmation',
        confirmText: 'share',
      });
      expect(sdkMock.addUsersToAlbum).toHaveBeenCalledExactlyOnceWith({
        id: album.id,
        addUsersDto: { albumUsers: users.map(({ id }) => ({ userId: id })), confirmPrivate: true },
      });
    });

    it('does nothing when sharing a private album is cancelled', async () => {
      const album = albumFactory.build({ isPrivate: true });
      vi.mocked(modalManager.showDialog).mockResolvedValue(false);

      const result = await handleAddUsersToAlbum(album, users);

      expect(result).toBeUndefined();
      expect(sdkMock.addUsersToAlbum).not.toHaveBeenCalled();
    });
  });

  describe('addAssetsToAlbums', () => {
    const assetIds = ['asset-1', 'asset-2'];

    beforeEach(() => {
      vi.clearAllMocks();
      sdkMock.addAssetsToAlbum.mockResolvedValue([]);
      sdkMock.addAssetsToAlbums.mockResolvedValue({ success: true });
    });

    it('asks for confirmation and forwards confirmPrivate when private assets go into a shared album', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);

      const result = await addAssetsToAlbums(['album-1'], assetIds, {
        notify: false,
        hasPrivate: true,
        isShared: true,
      });

      expect(result).toBe(true);
      expect(modalManager.showDialog).toHaveBeenCalledExactlyOnceWith({
        title: 'private_mode',
        prompt: 'share_private_assets_album_confirmation',
        confirmText: 'add',
      });
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: 'album-1', albumAddAssetsDto: { ids: assetIds, confirmPrivate: true } }),
      );
    });

    it('forwards confirmPrivate to the multi-album request as well', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);

      const result = await addAssetsToAlbums(['album-1', 'album-2'], assetIds, {
        notify: false,
        hasPrivate: true,
        isShared: true,
      });

      expect(result).toBe(true);
      expect(modalManager.showDialog).toHaveBeenCalledOnce();
      expect(sdkMock.addAssetsToAlbums).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          albumsAddAssetsDto: { albumIds: ['album-1', 'album-2'], assetIds, confirmPrivate: true },
        }),
      );
    });

    it('does not ask when the album is not shared or nothing is private', async () => {
      await addAssetsToAlbums(['album-1'], assetIds, { notify: false, hasPrivate: true, isShared: false });
      await addAssetsToAlbums(['album-1'], assetIds, { notify: false, hasPrivate: false, isShared: true });

      expect(modalManager.showDialog).not.toHaveBeenCalled();
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledTimes(2);
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledWith(
        expect.objectContaining({ albumAddAssetsDto: { ids: assetIds, confirmPrivate: undefined } }),
      );
    });

    it('does nothing when adding private assets to a shared album is cancelled', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(false);
      const onAlbumAddAssets = vi.fn();
      const unsubscribe = eventManager.on({ AlbumAddAssets: onAlbumAddAssets });

      const result = await addAssetsToAlbums(['album-1'], assetIds, {
        notify: false,
        hasPrivate: true,
        isShared: true,
      });

      expect(result).toBe(false);
      expect(sdkMock.addAssetsToAlbum).not.toHaveBeenCalled();
      expect(onAlbumAddAssets).not.toHaveBeenCalled();
      unsubscribe();
    });
  });

  describe('handleAlbumPrivateModeChange', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('navigates to the albums list when the mode turns off on a private album', async () => {
      const result = await handleAlbumPrivateModeChange(albumFactory.build({ isPrivate: true }), false);

      expect(result).toBe(true);
      expect(goto).toHaveBeenCalledExactlyOnceWith('/albums');
    });

    it('stays on a non-private album', async () => {
      const result = await handleAlbumPrivateModeChange(albumFactory.build({ isPrivate: false }), false);

      expect(result).toBe(false);
      expect(goto).not.toHaveBeenCalled();
    });

    it('stays on a private album when the mode turns on', async () => {
      const result = await handleAlbumPrivateModeChange(albumFactory.build({ isPrivate: true }), true);

      expect(result).toBe(false);
      expect(goto).not.toHaveBeenCalled();
    });
  });
});
