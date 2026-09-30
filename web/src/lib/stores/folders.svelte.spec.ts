import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { foldersStore } from '$lib/stores/folders.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';

describe('foldersStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    foldersStore.clearCache();
    sdkMock.getAssetsByOriginalPath.mockResolvedValue(assetFactory.buildList(1));
  });

  it('refetches a folder after private mode changes', async () => {
    await foldersStore.fetchAssetsByPath('holiday');
    await foldersStore.fetchAssetsByPath('holiday');
    expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledOnce();

    eventManager.emit('PrivateModeChange', true);

    await foldersStore.fetchAssetsByPath('holiday');
    expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(2);
  });
});
