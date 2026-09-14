import { getStack, StackSource, updateAsset } from '@immich/sdk';
import { fireEvent, waitFor } from '@testing-library/svelte';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getResizeObserverMock } from '$lib/__mocks__/resize-observer.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import AssetViewer from './AssetViewer.svelte';

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: {
    init: vi.fn(),
    loadFeatureFlags: vi.fn(),
    value: { smartSearch: true, trash: true },
  } as never,
}));

vi.mock('$lib/stores/ocr.svelte', () => ({
  ocrManager: {
    clear: vi.fn(),
    getAssetOcr: vi.fn(),
    hasOcrData: false,
    showOverlay: false,
  },
}));

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return {
    ...sdk,
    updateAsset: vi.fn(),
    getStack: vi.fn(),
  };
});

vi.mock('$lib/stores/face.svelte', () => ({
  faceManager: { clear: vi.fn(), getAssetFaces: vi.fn(), data: [] },
}));

describe('AssetViewer', () => {
  beforeAll(() => {
    Element.prototype.animate = getAnimateMock();
    vi.stubGlobal('ResizeObserver', getResizeObserverMock());
  });

  afterEach(() => {
    slideshowStore.slideshowState.set(SlideshowState.None);
    authManager.reset();
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it.skip('updates the top bar favorite action after pressing favorite', async () => {
    const ownerId = 'owner-id';
    const user = userAdminFactory.build({ id: ownerId });
    const asset = assetFactory.build({ ownerId, isFavorite: false, isTrashed: false });

    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));

    vi.mocked(updateAsset).mockResolvedValue({ ...asset, isFavorite: true });

    const { getByLabelText, queryByLabelText } = renderWithTooltips(AssetViewer, {
      cursor: { current: asset },
      showNavigation: false,
    });

    expect(getByLabelText('to_favorite')).toBeInTheDocument();
    expect(queryByLabelText('unfavorite')).toBeNull();

    await fireEvent.click(getByLabelText('to_favorite'));

    await waitFor(() =>
      expect(updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { isFavorite: true } }),
    );
    await waitFor(() => expect(getByLabelText('unfavorite')).toBeInTheDocument());
  });

  describe('stacks', () => {
    const renderStacked = (source: StackSource, groupAuto: boolean) => {
      const user = userAdminFactory.build();
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ stacks: { groupAuto } }));

      const asset = assetFactory.build({ ownerId: user.id });
      const other = assetFactory.build({ ownerId: user.id });
      asset.stack = { id: 'stack-id', primaryAssetId: asset.id, assetCount: 2, source };
      vi.mocked(getStack).mockResolvedValue({
        id: 'stack-id',
        primaryAssetId: asset.id,
        assets: [asset, other],
        source,
      });

      return renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false, withStacked: true });
    };

    it('loads a manual stack while automatic stacks are shown individually', async () => {
      renderStacked(StackSource.Manual, false);

      await waitFor(() => expect(getStack).toHaveBeenCalledWith({ id: 'stack-id' }));
    });

    it('loads an automatic stack while automatic stacks are grouped', async () => {
      renderStacked(StackSource.Auto, true);

      await waitFor(() => expect(getStack).toHaveBeenCalledWith({ id: 'stack-id' }));
    });

    it('does not load an automatic stack while automatic stacks are shown individually', async () => {
      const { container } = renderStacked(StackSource.Auto, false);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getStack).not.toHaveBeenCalled();
      expect(container.querySelector('#stack-slideshow')).toBeNull();
    });
  });
});
