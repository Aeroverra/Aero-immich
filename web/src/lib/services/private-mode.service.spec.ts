import { modalManager } from '@immich/ui';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import PrivateAlbumsModal from '$lib/modals/PrivateAlbumsModal.svelte';
import { handleMarkPrivateAlbums } from '$lib/services/private-mode.service';
import { albumFactory } from '@test-data/factories/album-factory';

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

vi.mock('$lib/utils/i18n', () => ({
  getFormatter: () => Promise.resolve((key: string) => key),
  getPreferredLocale: vi.fn(),
}));

describe('handleMarkPrivateAlbums', () => {
  const plainAlbum = albumFactory.build({ isPrivate: false });
  const sharedAlbum = albumFactory.build({ isPrivate: false, shared: true });
  const privateAlbum = albumFactory.build({ isPrivate: true });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.removeAssetFromAlbum.mockResolvedValue([]);
  });

  it('lists the non-private albums the assets appear in and proceeds when they are kept', async () => {
    sdkMock.getAllAlbums.mockImplementation(({ assetId }) =>
      Promise.resolve(assetId === 'asset-1' ? [plainAlbum, privateAlbum] : [plainAlbum, sharedAlbum]),
    );
    vi.mocked(modalManager.show).mockResolvedValue('keep' as never);

    const result = await handleMarkPrivateAlbums(['asset-1', 'asset-2']);

    expect(result).toBe(true);
    expect(sdkMock.getAllAlbums).toHaveBeenCalledTimes(2);
    expect(modalManager.show).toHaveBeenCalledExactlyOnceWith(PrivateAlbumsModal, {
      albums: [plainAlbum, sharedAlbum],
    });
    expect(sdkMock.removeAssetFromAlbum).not.toHaveBeenCalled();
  });

  it('skips the dialog when the assets are in no non-private album', async () => {
    sdkMock.getAllAlbums.mockResolvedValue([privateAlbum]);

    const result = await handleMarkPrivateAlbums(['asset-1']);

    expect(result).toBe(true);
    expect(modalManager.show).not.toHaveBeenCalled();
  });

  it('does not proceed when cancelled', async () => {
    sdkMock.getAllAlbums.mockResolvedValue([plainAlbum]);
    vi.mocked(modalManager.show).mockResolvedValue(undefined as never);

    const result = await handleMarkPrivateAlbums(['asset-1']);

    expect(result).toBe(false);
    expect(sdkMock.removeAssetFromAlbum).not.toHaveBeenCalled();
  });

  it('removes only the assets that are in each album before proceeding when asked to', async () => {
    sdkMock.getAllAlbums.mockImplementation(({ assetId }) =>
      Promise.resolve(assetId === 'asset-1' ? [plainAlbum, sharedAlbum] : [sharedAlbum]),
    );
    vi.mocked(modalManager.show).mockResolvedValue('remove' as never);

    const result = await handleMarkPrivateAlbums(['asset-1', 'asset-2']);

    expect(result).toBe(true);
    expect(sdkMock.removeAssetFromAlbum).toHaveBeenCalledTimes(2);
    expect(sdkMock.removeAssetFromAlbum).toHaveBeenCalledWith({
      id: plainAlbum.id,
      bulkIdsDto: { ids: ['asset-1'] },
    });
    expect(sdkMock.removeAssetFromAlbum).toHaveBeenCalledWith({
      id: sharedAlbum.id,
      bulkIdsDto: { ids: ['asset-1', 'asset-2'] },
    });
  });

  it('does not proceed when a removal fails', async () => {
    sdkMock.getAllAlbums.mockResolvedValue([plainAlbum]);
    vi.mocked(modalManager.show).mockResolvedValue('remove' as never);
    sdkMock.removeAssetFromAlbum.mockRejectedValue(new Error('nope'));

    const result = await handleMarkPrivateAlbums(['asset-1']);

    expect(result).toBe(false);
  });
});
