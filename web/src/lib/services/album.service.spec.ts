import { modalManager } from '@immich/ui';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handleAddUsersToAlbum } from '$lib/services/album.service';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

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
});
