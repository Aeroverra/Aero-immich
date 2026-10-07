import { SharedLinkType, type ServerConfigDto } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { asUrl, handleCreateSharedLink } from '$lib/services/shared-link.service';
import { sharedLinkFactory } from '@test-data/factories/shared-link-factory';

vi.mock(import('$lib/managers/server-config-manager.svelte'), () => ({
  serverConfigManager: {
    value: { externalDomain: 'http://localhost:2283' } as ServerConfigDto,
    init: vi.fn(),
    loadServerConfig: vi.fn(),
  },
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

describe('SharedLinkService', () => {
  describe('asUrl', () => {
    it('should properly encode characters in slug', () => {
      expect(asUrl(sharedLinkFactory.build({ slug: 'foo/bar' }))).toBe('http://localhost:2283/s/foo%2Fbar');
    });
  });

  describe('handleCreateSharedLink', () => {
    const dto = { type: SharedLinkType.Individual, assetIds: ['asset-1'] };

    beforeEach(() => {
      vi.clearAllMocks();
      sdkMock.createSharedLink.mockResolvedValue(sharedLinkFactory.build({ type: SharedLinkType.Individual }));
    });

    it('creates the link without asking when nothing is private', async () => {
      const result = await handleCreateSharedLink(dto, { hasPrivate: false });

      expect(result).toBe(true);
      expect(modalManager.showDialog).not.toHaveBeenCalled();
      expect(sdkMock.createSharedLink).toHaveBeenCalledExactlyOnceWith({ sharedLinkCreateDto: dto });
    });

    it('asks for confirmation and forwards confirmPrivate when assets are private', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);

      const result = await handleCreateSharedLink(dto, { hasPrivate: true });

      expect(result).toBe(true);
      expect(modalManager.showDialog).toHaveBeenCalledExactlyOnceWith({
        title: 'private_mode',
        prompt: 'share_private_assets_confirmation',
        confirmText: 'create_link',
      });
      expect(sdkMock.createSharedLink).toHaveBeenCalledExactlyOnceWith({
        sharedLinkCreateDto: { ...dto, confirmPrivate: true },
      });
    });

    it('uses the album wording for a private album link', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);
      sdkMock.getSharedLinkById.mockResolvedValue(sharedLinkFactory.build({ type: SharedLinkType.Album }));

      await handleCreateSharedLink({ type: SharedLinkType.Album, albumId: 'album-1' }, { hasPrivate: true });

      expect(modalManager.showDialog).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'share_private_album_confirmation' }),
      );
      expect(sdkMock.createSharedLink).toHaveBeenCalledExactlyOnceWith({
        sharedLinkCreateDto: { type: SharedLinkType.Album, albumId: 'album-1', confirmPrivate: true },
      });
    });

    it('does not create the link when the confirmation is declined', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(false);

      const result = await handleCreateSharedLink(dto, { hasPrivate: true });

      expect(result).toBe(false);
      expect(sdkMock.createSharedLink).not.toHaveBeenCalled();
    });
  });
});
