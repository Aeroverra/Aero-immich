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
    sdkMock.getAlbumsForAssets.mockResolvedValue([
      { album: plainAlbum, assetIds: ['asset-1', 'asset-2'] },
      { album: privateAlbum, assetIds: ['asset-1'] },
      { album: sharedAlbum, assetIds: ['asset-2'] },
    ]);
    vi.mocked(modalManager.show).mockResolvedValue('keep' as never);

    const result = await handleMarkPrivateAlbums(['asset-1', 'asset-2']);

    expect(result).toBe(true);
    expect(sdkMock.getAlbumsForAssets).toHaveBeenCalledExactlyOnceWith({
      albumsForAssetsDto: { assetIds: ['asset-1', 'asset-2'] },
    });
    expect(modalManager.show).toHaveBeenCalledExactlyOnceWith(PrivateAlbumsModal, {
      albums: [plainAlbum, sharedAlbum],
    });
    expect(sdkMock.removeAssetFromAlbum).not.toHaveBeenCalled();
  });

  it('skips the dialog when the assets are in no non-private album', async () => {
    sdkMock.getAlbumsForAssets.mockResolvedValue([{ album: privateAlbum, assetIds: ['asset-1'] }]);

    const result = await handleMarkPrivateAlbums(['asset-1']);

    expect(result).toBe(true);
    expect(modalManager.show).not.toHaveBeenCalled();
  });

  it('does not proceed when cancelled', async () => {
    sdkMock.getAlbumsForAssets.mockResolvedValue([{ album: plainAlbum, assetIds: ['asset-1'] }]);
    vi.mocked(modalManager.show).mockResolvedValue(undefined as never);

    const result = await handleMarkPrivateAlbums(['asset-1']);

    expect(result).toBe(false);
    expect(sdkMock.removeAssetFromAlbum).not.toHaveBeenCalled();
  });

  it('removes only the assets that are in each album before proceeding when asked to', async () => {
    sdkMock.getAlbumsForAssets.mockResolvedValue([
      { album: plainAlbum, assetIds: ['asset-1'] },
      { album: sharedAlbum, assetIds: ['asset-1', 'asset-2'] },
    ]);
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
    sdkMock.getAlbumsForAssets.mockResolvedValue([{ album: plainAlbum, assetIds: ['asset-1'] }]);
    vi.mocked(modalManager.show).mockResolvedValue('remove' as never);
    sdkMock.removeAssetFromAlbum.mockRejectedValue(new Error('nope'));

    const result = await handleMarkPrivateAlbums(['asset-1']);

    expect(result).toBe(false);
  });

  it('looks up the albums of a large selection with a single request', async () => {
    const assetIds = Array.from({ length: 30_000 }, (_, index) => `asset-${index}`);
    sdkMock.getAlbumsForAssets.mockResolvedValue([{ album: plainAlbum, assetIds: ['asset-7'] }]);
    vi.mocked(modalManager.show).mockResolvedValue('keep' as never);

    const result = await handleMarkPrivateAlbums(assetIds);

    expect(result).toBe(true);
    expect(sdkMock.getAlbumsForAssets).toHaveBeenCalledExactlyOnceWith({ albumsForAssetsDto: { assetIds } });
    expect(sdkMock.getAllAlbums).not.toHaveBeenCalled();
  });

  it('does not proceed when the album lookup fails', async () => {
    sdkMock.getAlbumsForAssets.mockRejectedValue(new Error('nope'));

    const result = await handleMarkPrivateAlbums(['asset-1']);

    expect(result).toBe(false);
    expect(modalManager.show).not.toHaveBeenCalled();
  });
});
