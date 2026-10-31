import { modalManager } from '@immich/ui';
import { mdiLockOutline } from '@mdi/js';
import { goto, invalidateAll } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
import {
  addAssetsToAlbums,
  handleAddUsersToAlbum,
  handleAlbumPrivateModeChange,
  handleAlbumRemoteUpdate,
} from '$lib/services/album.service';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
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
    const publicAlbum = albumFactory.build({ albumName: 'Trip', isPrivate: false, assetCount: 3 });
    const sharedPublicAlbum = albumFactory.build({ albumName: 'Party', isPrivate: false, assetCount: 3, shared: true });
    const sharedPrivateAlbum = albumFactory.build({ isPrivate: true, assetCount: 3, hasSharedLink: true });

    beforeEach(() => {
      vi.clearAllMocks();
      sdkMock.addAssetsToAlbum.mockResolvedValue([]);
      sdkMock.addAssetsToAlbums.mockResolvedValue({ success: true });
    });

    it('asks before a private asset turns a public album private', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);

      const result = await addAssetsToAlbums([publicAlbum.id], assetIds, {
        notify: false,
        hasPrivate: true,
        albums: [publicAlbum],
      });

      expect(result).toBe(true);
      expect(modalManager.showDialog).toHaveBeenCalledExactlyOnceWith({
        title: 'private_mode',
        prompt: 'add_to_album_private_prompt',
        confirmText: 'add_to_album_private_confirm',
        confirmColor: 'primary',
        icon: mdiLockOutline,
      });
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: publicAlbum.id, albumAddAssetsDto: { ids: assetIds, confirmPrivate: true } }),
      );
    });

    it('does not ask when only public assets go into a public album', async () => {
      await addAssetsToAlbums([publicAlbum.id], assetIds, { notify: false, hasPrivate: false, albums: [publicAlbum] });

      expect(modalManager.showDialog).not.toHaveBeenCalled();
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ albumAddAssetsDto: { ids: assetIds, confirmPrivate: undefined } }),
      );
    });

    it('folds the shared warning into the same dialog for a shared public album', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);

      const result = await addAssetsToAlbums([sharedPublicAlbum.id], assetIds, {
        notify: false,
        hasPrivate: true,
        albums: [sharedPublicAlbum],
      });

      expect(result).toBe(true);
      expect(modalManager.showDialog).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ prompt: 'add_to_album_private_prompt add_to_album_shared_private_prompt' }),
      );
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ albumAddAssetsDto: { ids: assetIds, confirmPrivate: true } }),
      );
    });

    it('only warns about sharing for an album that is already private', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);

      await addAssetsToAlbums([sharedPrivateAlbum.id], assetIds, {
        notify: false,
        hasPrivate: true,
        albums: [sharedPrivateAlbum],
      });

      expect(modalManager.showDialog).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ prompt: 'add_to_album_shared_private_prompt' }),
      );
    });

    it('does not ask for an empty album, which is private from the start', async () => {
      const newAlbum = albumFactory.build({ isPrivate: false, assetCount: 0 });

      const result = await addAssetsToAlbums([newAlbum.id], assetIds, {
        notify: false,
        hasPrivate: true,
        albums: [newAlbum],
      });

      expect(result).toBe(true);
      expect(modalManager.showDialog).not.toHaveBeenCalled();
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledOnce();
    });

    it('forwards confirmPrivate to the multi-album request as well', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);

      const result = await addAssetsToAlbums([publicAlbum.id, sharedPublicAlbum.id], assetIds, {
        notify: false,
        hasPrivate: true,
        albums: [publicAlbum, sharedPublicAlbum],
      });

      expect(result).toBe(true);
      expect(modalManager.showDialog).toHaveBeenCalledOnce();
      expect(sdkMock.addAssetsToAlbums).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          albumsAddAssetsDto: { albumIds: [publicAlbum.id, sharedPublicAlbum.id], assetIds, confirmPrivate: true },
        }),
      );
    });

    it('adds nothing when cancelled', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(false);
      const onAlbumAddAssets = vi.fn();
      const unsubscribe = eventManager.on({ AlbumAddAssets: onAlbumAddAssets });

      const result = await addAssetsToAlbums([publicAlbum.id], assetIds, {
        notify: false,
        hasPrivate: true,
        albums: [publicAlbum],
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

  describe('handleAlbumRemoteUpdate', () => {
    const onAlbumUpdate = vi.fn();
    let unsubscribe: () => void;

    beforeEach(() => {
      vi.clearAllMocks();
      vi.spyOn(privateModeManager, 'invalidate').mockImplementation(() => {});
      unsubscribe = eventManager.on({ AlbumUpdate: onAlbumUpdate });
    });

    afterEach(() => {
      unsubscribe();
    });

    it('reloads the album and announces it', async () => {
      const album = albumFactory.build();
      sdkMock.getAlbumInfo.mockResolvedValue(album);

      await handleAlbumRemoteUpdate(album.id);

      expect(sdkMock.getAlbumInfo).toHaveBeenCalledExactlyOnceWith({ id: album.id });
      expect(onAlbumUpdate).toHaveBeenCalledExactlyOnceWith(album);
      expect(invalidateAll).toHaveBeenCalledOnce();
      expect(privateModeManager.invalidate).not.toHaveBeenCalled();
    });

    it('reloads everything private-dependent when the album is no longer visible', async () => {
      sdkMock.getAlbumInfo.mockRejectedValue(new Error('Bad Request'));

      await handleAlbumRemoteUpdate('album-1');

      expect(privateModeManager.invalidate).toHaveBeenCalledOnce();
      expect(onAlbumUpdate).not.toHaveBeenCalled();
      expect(invalidateAll).not.toHaveBeenCalled();
    });
  });
});
