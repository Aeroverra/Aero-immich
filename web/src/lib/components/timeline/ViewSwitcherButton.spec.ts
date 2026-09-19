import { ViewAccess, ViewPrivateAssets, type CustomViewResponseDto } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import '@testing-library/jest-dom';
import { cleanup, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
import { viewManager } from '$lib/managers/view-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import ViewSwitcherButton from './ViewSwitcherButton.svelte';

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), () => ({
  featureFlagsManager: { init: vi.fn(), value: { customViews: true } } as never,
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

describe('ViewSwitcherButton component', () => {
  const defaultView = newView({ id: 'default', name: 'Reviewed', isDefault: true, includeAll: true });
  const family = newView();
  const gym = newView({ id: 'view-2', name: 'Gym', access: ViewAccess.Locked });

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    featureFlagsManager.value.customViews = true;
    authManager.setUser(userAdminFactory.build());
    authManager.setPreferences(preferencesFactory.build());
    viewManager.reset();
    vi.spyOn(privateModeManager, 'invalidate').mockImplementation(() => {});
    sdkMock.getCustomViews.mockResolvedValue([defaultView, family, gym]);
    sdkMock.getActiveCustomView.mockResolvedValue({ viewId: null, view: defaultView, expiresAt: null });
  });

  afterEach(() => {
    cleanup();
    authManager.reset();
  });

  it('is hidden while the user has no views', async () => {
    sdkMock.getCustomViews.mockResolvedValue([]);

    renderWithTooltips(ViewSwitcherButton, {});

    await waitFor(() => expect(sdkMock.getCustomViews).toHaveBeenCalled());
    expect(screen.queryByTestId('view-switcher')).not.toBeInTheDocument();
  });

  it('shows the active view and switches to an open view without a pin', async () => {
    sdkMock.setActiveCustomView.mockResolvedValue({ viewId: family.id, view: family, expiresAt: null });
    const user = userEvent.setup();

    renderWithTooltips(ViewSwitcherButton, {});

    const button = await screen.findByRole('button', { name: 'View: Reviewed' });
    await user.click(button);
    await user.click(screen.getByText('Family'));

    expect(sdkMock.setActiveCustomView).toHaveBeenCalledWith({
      customViewActiveUpdateDto: { viewId: family.id, pinCode: undefined },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'View: Family' })).toBeInTheDocument());
  });

  it('asks for the pin before switching to a locked view', async () => {
    const show = vi.spyOn(modalManager, 'show').mockResolvedValue(undefined as never);
    const user = userEvent.setup();

    renderWithTooltips(ViewSwitcherButton, {});

    await user.click(await screen.findByRole('button', { name: 'View: Reviewed' }));
    await user.click(screen.getByText('Gym'));

    expect(show).toHaveBeenCalledOnce();
    expect(show.mock.calls[0][1]).toEqual(expect.objectContaining({ title: 'Switch to Gym' }));
    expect(sdkMock.setActiveCustomView).not.toHaveBeenCalled();
  });
});
