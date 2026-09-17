import { ViewAccess, ViewPrivateAssets, type CustomViewResponseDto } from '@immich/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
import { viewManager } from '$lib/managers/view-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), () => ({
  featureFlagsManager: { init: vi.fn(), value: { views: true } } as never,
}));

const newView = (overrides: Partial<CustomViewResponseDto> = {}): CustomViewResponseDto => ({
  id: 'view-1',
  name: 'Family',
  order: 0,
  isDefault: false,
  access: ViewAccess.Open,
  includeAll: false,
  includeUntagged: false,
  includeTagIds: ['tag-1'],
  excludeTagIds: [],
  privateAssets: ViewPrivateAssets.Unlocked,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('ViewManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    featureFlagsManager.value.views = true;
    authManager.setUser(userAdminFactory.build());
    authManager.setPreferences(preferencesFactory.build());
    viewManager.reset();
    vi.spyOn(privateModeManager, 'invalidate').mockImplementation(() => {});
  });

  it('does nothing on a server without views', async () => {
    featureFlagsManager.value.views = undefined;

    await viewManager.load();

    expect(sdkMock.getCustomViews).not.toHaveBeenCalled();
  });

  it('loads the views and the active view, and separates the default view', async () => {
    const defaultView = newView({ id: 'default', name: 'Reviewed', isDefault: true });
    const family = newView();
    sdkMock.getCustomViews.mockResolvedValue([defaultView, family]);
    sdkMock.getActiveCustomView.mockResolvedValue({ viewId: null, view: defaultView, expiresAt: null });

    await viewManager.load();

    expect(viewManager.defaultView).toEqual(defaultView);
    expect(viewManager.otherViews).toEqual([family]);
    expect(viewManager.active.view).toEqual(defaultView);
    expect(privateModeManager.invalidate).not.toHaveBeenCalled();
  });

  it('reloads what is on screen when the server fell back to the default view', async () => {
    const family = newView();
    sdkMock.getCustomViews.mockResolvedValue([family]);
    sdkMock.getActiveCustomView.mockResolvedValue({ viewId: family.id, view: family, expiresAt: null });
    await viewManager.load();

    sdkMock.getActiveCustomView.mockResolvedValue({ viewId: null, view: null, expiresAt: null });
    await viewManager.load();

    expect(viewManager.active.viewId).toBeNull();
    expect(privateModeManager.invalidate).toHaveBeenCalledOnce();
  });

  it('switches with the pin code and reloads what is on screen', async () => {
    const locked = newView({ access: ViewAccess.Locked });
    sdkMock.setActiveCustomView.mockResolvedValue({ viewId: locked.id, view: locked, expiresAt: null });

    await viewManager.switch(locked.id, '123456');

    expect(sdkMock.setActiveCustomView).toHaveBeenCalledWith({
      customViewActiveUpdateDto: { viewId: locked.id, pinCode: '123456' },
    });
    expect(viewManager.active.viewId).toBe(locked.id);
    expect(privateModeManager.invalidate).toHaveBeenCalledOnce();
  });

  it('keeps the current view when a switch fails', async () => {
    sdkMock.setActiveCustomView.mockRejectedValue(new Error('Wrong PIN code'));

    await expect(viewManager.switch('view-1', '000000')).rejects.toThrow('Wrong PIN code');

    expect(viewManager.active.viewId).toBeNull();
    expect(privateModeManager.invalidate).not.toHaveBeenCalled();
  });
});
