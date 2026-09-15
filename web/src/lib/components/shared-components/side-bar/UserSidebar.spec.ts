import { cleanup, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import UserSidebar from '$lib/components/shared-components/side-bar/UserSidebar.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), () => ({
  featureFlagsManager: { init: vi.fn(), loadFeatureFlags: vi.fn(), value: { trash: false, map: false } } as never,
}));

vi.mock('$lib/components/shared-components/side-bar/BottomInfo.svelte', async () => {
  return await import('@test-data/mocks/Empty.mock.svelte');
});

describe('UserSidebar component', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    sdkMock.getAllAlbums.mockResolvedValue([]);
    authManager.setUser(userAdminFactory.build());
  });

  afterEach(() => {
    // unmount before the preferences go away, the sidebar reads them reactively
    cleanup();
    privateModeManager.enabled = false;
    authManager.reset();
  });

  it.each([
    { sidebarWeb: true, enabled: true, shown: true },
    { sidebarWeb: true, enabled: false, shown: false },
    { sidebarWeb: false, enabled: true, shown: false },
    { sidebarWeb: false, enabled: false, shown: false },
  ])(
    'shows the Private page only when the preference is on and the mode is on (sidebarWeb $sidebarWeb, mode $enabled)',
    ({ sidebarWeb, enabled, shown }) => {
      authManager.setPreferences(preferencesFactory.build({ privateMode: { sidebarWeb, timeoutMinutes: 30 } }));
      privateModeManager.enabled = enabled;

      render(UserSidebar);

      const link = screen.queryByRole('link', { name: 'Private' });
      if (shown) {
        expect(link).toHaveAttribute('href', '/private');
      } else {
        expect(link).not.toBeInTheDocument();
      }
    },
  );
});
