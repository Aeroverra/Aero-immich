import { AlbumUserRole } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { createAlbum } from '$lib/utils/album-utils';
import { albumFactory } from '@test-data/factories/album-factory';

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
      danger: vi.fn(),
    },
  };
});

describe('album-utils', () => {
  describe('createAlbum', () => {
    const assetIds = ['asset-1', 'asset-2'];
    const albumUsers = [{ userId: 'user-2', role: AlbumUserRole.Editor }];

    beforeAll(async () => {
      await init({ fallbackLocale: 'en-US' });
      register('en-US', () => import('$i18n/en.json'));
      await waitLocale('en-US');
    });

    beforeEach(() => {
      vi.clearAllMocks();
      sdkMock.createAlbum.mockResolvedValue(albumFactory.build());
    });

    it('asks for confirmation and forwards confirmPrivate when a shared album is created with private assets', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);
      const onAlbumCreate = vi.fn();
      const unsubscribe = eventManager.on({ AlbumCreate: onAlbumCreate });

      const album = await createAlbum('Trip', assetIds, { albumUsers, hasPrivate: true });

      expect(album).toBeDefined();
      expect(modalManager.showDialog).toHaveBeenCalledExactlyOnceWith({
        title: 'Private mode',
        prompt:
          'Your selection includes private photos or videos. Everyone this album is shared with will be able to see them. Continue?',
        confirmText: 'Create album',
      });
      expect(sdkMock.createAlbum).toHaveBeenCalledExactlyOnceWith({
        createAlbumDto: { albumName: 'Trip', assetIds, albumUsers, confirmPrivate: true },
      });
      expect(onAlbumCreate).toHaveBeenCalledOnce();
      unsubscribe();
    });

    it('does not ask when the album has no users or no private assets', async () => {
      await createAlbum('Trip', assetIds, { hasPrivate: true });
      await createAlbum('Trip', assetIds, { albumUsers, hasPrivate: false });

      expect(modalManager.showDialog).not.toHaveBeenCalled();
      expect(sdkMock.createAlbum).toHaveBeenCalledTimes(2);
      expect(sdkMock.createAlbum).toHaveBeenLastCalledWith({
        createAlbumDto: { albumName: 'Trip', assetIds, albumUsers, confirmPrivate: undefined },
      });
    });

    it('does nothing when sharing private assets is declined', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(false);

      const album = await createAlbum('Trip', assetIds, { albumUsers, hasPrivate: true });

      expect(album).toBeUndefined();
      expect(sdkMock.createAlbum).not.toHaveBeenCalled();
    });
  });
});
