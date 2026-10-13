import { toastManager, type ToastButton } from '@immich/ui';
import { waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { AssetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { toTimelineAsset } from '$lib/utils/timeline-util';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import GalleryViewer from './GalleryViewer.svelte';

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { init: vi.fn(), loadFeatureFlags: vi.fn(), value: { trash: true } } as never,
}));

vi.mock('@immich/ui', async (originalImport) => {
  const module = await originalImport<typeof import('@immich/ui')>();
  return {
    ...module,
    toastManager: {
      primary: vi.fn(),
      danger: vi.fn(),
      success: vi.fn(),
    },
  };
});

const shownAssetIds = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-asset]')].map((element) => element.dataset.asset);

const clickUndo = () => {
  const [item] = vi.mocked(toastManager.primary).mock.calls.at(-1)!;
  const button = (item as { button: (close: () => void) => ToastButton }).button(vi.fn());
  (button.onclick as () => void)();
};

describe('GalleryViewer', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.deleteAssets.mockResolvedValue(undefined as never);
    sdkMock.restoreAssets.mockResolvedValue(undefined as never);
  });

  it('puts trashed assets back in their places when the trash is undone', async () => {
    const assets = ['a', 'b', 'c', 'd'].map((id) => assetFactory.build({ id, isTrashed: false }));
    const assetInteraction = new AssetMultiSelectManager();
    const { container } = renderWithTooltips(GalleryViewer, {
      assets,
      assetInteraction,
      viewport: { width: 1200, height: 900 },
    });

    await waitFor(() => expect(shownAssetIds(container)).toEqual(['a', 'b', 'c', 'd']));

    assetInteraction.selectAssets([assets[1], assets[3]].map((asset) => toTimelineAsset(asset)));
    await userEvent.keyboard('{Delete}');

    await waitFor(() => expect(shownAssetIds(container)).toEqual(['a', 'c']));
    expect(sdkMock.deleteAssets).toHaveBeenCalledWith({ assetBulkDeleteDto: { ids: ['b', 'd'], force: false } });

    clickUndo();

    await waitFor(() => expect(shownAssetIds(container)).toEqual(['a', 'b', 'c', 'd']));
    expect(sdkMock.restoreAssets).toHaveBeenCalledWith({ bulkIdsDto: { ids: ['b', 'd'] } });
  });

  it('lets the page reload instead when it knows how', async () => {
    const assets = ['a', 'b'].map((id) => assetFactory.build({ id, isTrashed: false }));
    const assetInteraction = new AssetMultiSelectManager();
    const onReload = vi.fn();
    const { container } = renderWithTooltips(GalleryViewer, {
      assets,
      assetInteraction,
      onReload,
      viewport: { width: 1200, height: 900 },
    });

    await waitFor(() => expect(shownAssetIds(container)).toEqual(['a', 'b']));
    assetInteraction.selectAssets([toTimelineAsset(assets[0])]);
    await userEvent.keyboard('{Delete}');
    await waitFor(() => expect(shownAssetIds(container)).toEqual(['b']));

    clickUndo();

    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
  });
});
