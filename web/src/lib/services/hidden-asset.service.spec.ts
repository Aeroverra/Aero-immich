import { ViewAccess, ViewPrivateAssets, type CustomViewResponseDto } from '@immich/sdk';
import { modalManager, toastManager } from '@immich/ui';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { viewManager } from '$lib/managers/view-manager.svelte';
import HiddenAssetViewModal from '$lib/modals/HiddenAssetViewModal.svelte';
import PrivateModePinModal from '$lib/modals/PrivateModePinModal.svelte';
import { getHiddenAsset, handleHiddenAsset, isHiddenAssetError } from '$lib/services/hidden-asset.service';

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
      warning: vi.fn(),
    },
  };
});

vi.mock('$lib/utils/i18n', () => ({
  getFormatter: () => Promise.resolve((key: string) => key),
  getPreferredLocale: vi.fn(),
}));

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), () => ({
  featureFlagsManager: { init: vi.fn(), value: { customViews: true } } as never,
}));

const newView = (overrides: Partial<CustomViewResponseDto> = {}): CustomViewResponseDto => ({
  id: 'view-1',
  name: 'All',
  order: 0,
  isDefault: false,
  access: ViewAccess.Private,
  includeAll: true,
  includeUntagged: false,
  includeTagIds: [],
  excludeTagIds: [],
  privateAssets: ViewPrivateAssets.Unlocked,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const authStatus = (overrides: { pinCode?: boolean; privateMode?: boolean } = {}) => ({
  isElevated: false,
  password: true,
  pinCode: true,
  privateMode: false,
  ...overrides,
});

const notFound = Object.assign(new Error('Not found or no asset.read access'), {
  status: 400,
  data: { message: 'Not found or no asset.read access' },
});

describe('hidden asset service', () => {
  const defaultView = newView({ id: 'default', name: 'Default', isDefault: true, access: ViewAccess.Open });
  const all = newView();
  const gym = newView({ id: 'view-2', name: 'Gym', access: ViewAccess.Locked });

  beforeEach(() => {
    vi.clearAllMocks();
    featureFlagsManager.value.customViews = true;
    vi.spyOn(viewManager, 'switch').mockResolvedValue();
    sdkMock.getAuthStatus.mockResolvedValue(authStatus());
    sdkMock.getActiveCustomView.mockResolvedValue({ viewId: null, view: defaultView, expiresAt: null });
    sdkMock.getCustomViews.mockImplementation(({ assetId }) =>
      assetId ? Promise.reject(notFound) : Promise.resolve([defaultView, all, gym]),
    );
    sdkMock.getAssetInfo.mockRejectedValue(notFound);
  });

  describe('isHiddenAssetError', () => {
    it('only treats a 400 as a possibly hidden asset', () => {
      sdkMock.isHttpError.mockImplementation((error) => typeof (error as { status?: number }).status === 'number');

      expect(isHiddenAssetError(notFound)).toBe(true);
      expect(isHiddenAssetError(Object.assign(new Error('boom'), { status: 500, data: {} }))).toBe(false);
      expect(isHiddenAssetError(new Error('network'))).toBe(false);
    });
  });

  describe('getHiddenAsset', () => {
    it('offers the PIN while private mode is off, even when nothing can be told about the asset', async () => {
      await expect(getHiddenAsset('asset-1')).resolves.toEqual({
        assetId: 'asset-1',
        canUnlock: true,
        views: [],
        allPhotos: false,
      });
    });

    it('offers nothing without a PIN or once private mode is on and no view shows the asset', async () => {
      sdkMock.getAuthStatus.mockResolvedValue(authStatus({ pinCode: false }));
      await expect(getHiddenAsset('asset-1')).resolves.toBeUndefined();

      sdkMock.getAuthStatus.mockResolvedValue(authStatus({ privateMode: true }));
      await expect(getHiddenAsset('asset-1')).resolves.toBeUndefined();
    });

    it('offers the views that show the asset', async () => {
      sdkMock.getAuthStatus.mockResolvedValue(authStatus({ privateMode: true }));
      sdkMock.getCustomViews.mockImplementation(({ assetId }) =>
        Promise.resolve(assetId ? [all, gym] : [defaultView, all, gym]),
      );

      await expect(getHiddenAsset('asset-1')).resolves.toEqual({
        assetId: 'asset-1',
        canUnlock: false,
        views: [all, gym],
        allPhotos: false,
        currentViewName: 'Default',
      });
    });

    it('offers all photos when a switched session hides the asset and there is no default view', async () => {
      sdkMock.getActiveCustomView.mockResolvedValue({ viewId: gym.id, view: gym, expiresAt: null });
      sdkMock.getCustomViews.mockImplementation(({ assetId }) => Promise.resolve(assetId ? [gym] : [all, gym]));

      await expect(getHiddenAsset('asset-1')).resolves.toMatchObject({
        views: [],
        allPhotos: true,
        currentViewName: 'Gym',
      });
    });

    it('does not ask for views when the server has none', async () => {
      featureFlagsManager.value.customViews = false;

      await expect(getHiddenAsset('asset-1')).resolves.toMatchObject({ canUnlock: true, views: [] });
      expect(sdkMock.getCustomViews).not.toHaveBeenCalled();
    });
  });

  describe('handleHiddenAsset', () => {
    const hidden = { assetId: 'asset-1', canUnlock: true, views: [], allPhotos: false };

    it('stops when the PIN dialog is cancelled', async () => {
      vi.mocked(modalManager.show).mockResolvedValue(undefined as never);

      await expect(handleHiddenAsset(hidden)).resolves.toBe(false);
      expect(modalManager.show).toHaveBeenCalledExactlyOnceWith(PrivateModePinModal, {
        description: 'hidden_asset_unlock_description',
      });
    });

    it('is done once private mode shows the asset', async () => {
      vi.mocked(modalManager.show).mockResolvedValue(true as never);
      sdkMock.getAssetInfo.mockResolvedValue({} as never);

      await expect(handleHiddenAsset(hidden)).resolves.toBe(true);
      expect(modalManager.show).toHaveBeenCalledOnce();
      expect(viewManager.switch).not.toHaveBeenCalled();
    });

    it('offers the views that show the asset after the PIN and switches to the chosen one', async () => {
      sdkMock.getCustomViews.mockImplementation(({ assetId }) =>
        Promise.resolve(assetId ? [all, gym] : [defaultView, all, gym]),
      );
      vi.mocked(modalManager.show)
        .mockResolvedValueOnce(true as never)
        .mockResolvedValueOnce({ view: all } as never);

      await expect(handleHiddenAsset(hidden)).resolves.toBe(true);
      expect(modalManager.show).toHaveBeenLastCalledWith(HiddenAssetViewModal, {
        views: [all, gym],
        allPhotos: false,
        currentViewName: 'Default',
      });
      expect(viewManager.switch).toHaveBeenCalledExactlyOnceWith(all.id);
    });

    it('skips the PIN when an available view already shows the asset', async () => {
      vi.mocked(modalManager.show).mockResolvedValueOnce({ view: defaultView } as never);

      await expect(handleHiddenAsset({ ...hidden, views: [defaultView], currentViewName: 'Gym' })).resolves.toBe(true);
      expect(modalManager.show).toHaveBeenCalledExactlyOnceWith(HiddenAssetViewModal, {
        views: [defaultView],
        allPhotos: false,
        currentViewName: 'Gym',
      });
      // the default view is the session without a switched view
      expect(viewManager.switch).toHaveBeenCalledExactlyOnceWith(null);
    });

    it('asks for the PIN again to switch to a locked view', async () => {
      vi.mocked(modalManager.show)
        .mockResolvedValueOnce({ view: gym } as never)
        .mockResolvedValueOnce(true as never);

      await expect(handleHiddenAsset({ ...hidden, canUnlock: false, views: [gym] })).resolves.toBe(true);
      expect(modalManager.show).toHaveBeenLastCalledWith(
        PrivateModePinModal,
        expect.objectContaining({ title: 'custom_view_switch_locked_title', onPinCode: expect.any(Function) }),
      );
    });

    it('leaves the view alone when the choice is cancelled', async () => {
      vi.mocked(modalManager.show).mockResolvedValueOnce(undefined as never);

      await expect(handleHiddenAsset({ ...hidden, views: [all] })).resolves.toBe(false);
      expect(viewManager.switch).not.toHaveBeenCalled();
    });

    it('reports a missing asset once private mode is on and no view shows it', async () => {
      vi.mocked(modalManager.show).mockResolvedValueOnce(true as never);

      await expect(handleHiddenAsset(hidden)).resolves.toBe(false);
      expect(toastManager.warning).toHaveBeenCalledWith('hidden_asset_not_found');
      expect(modalManager.show).toHaveBeenCalledOnce();
    });
  });
});
