import { LockTrigger } from '@immich/sdk';
import '@testing-library/jest-dom';
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import FeatureSettings from './FeatureSettings.svelte';

vi.mock(import('$lib/managers/server-config-manager.svelte'), () => ({
  serverConfigManager: { value: { minFaces: 3 }, init: vi.fn(), loadServerConfig: vi.fn() } as never,
}));

// every accordion open, so the private mode fields are rendered
vi.mock(import('$lib/managers/accordion-manager.svelte'), () => ({
  accordionManager: { isOpen: () => true, open: vi.fn(), close: vi.fn() } as never,
}));

describe('FeatureSettings component', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    authManager.setUser(userAdminFactory.build());
  });

  afterEach(() => {
    cleanup();
    authManager.reset();
  });

  it('saves the private memories preference with the other private mode settings', async () => {
    const preferences = preferencesFactory.build({
      privateMode: { sidebarWeb: true, timeoutMinutes: 45, includeInMemories: false },
    });
    authManager.setPreferences(preferences);
    sdkMock.updateMyPreferences.mockResolvedValue({
      ...preferences,
      privateMode: { sidebarWeb: true, timeoutMinutes: 45, includeInMemories: true, lockTrigger: LockTrigger.AppPause },
    });
    const user = userEvent.setup();

    render(FeatureSettings);

    const toggle = screen.getByRole('switch', { name: 'Include private photos in memories' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
        userPreferencesUpdateDto: expect.objectContaining({
          privateMode: { sidebarWeb: true, timeoutMinutes: 45, includeInMemories: true },
        }),
      }),
    );
    expect(authManager.preferences.privateMode.includeInMemories).toBe(true);
  });

  it('reads the current private memories preference', () => {
    authManager.setPreferences(
      preferencesFactory.build({ privateMode: { sidebarWeb: true, timeoutMinutes: 30, includeInMemories: true } }),
    );

    render(FeatureSettings);

    expect(screen.getByRole('switch', { name: 'Include private photos in memories' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('saves the automatic stacks grouping preference', async () => {
    const preferences = preferencesFactory.build({ stacks: { groupAuto: true } });
    authManager.setPreferences(preferences);
    sdkMock.updateMyPreferences.mockResolvedValue({ ...preferences, stacks: { groupAuto: false } });
    const user = userEvent.setup();

    render(FeatureSettings);

    const toggle = screen.getByRole('switch', { name: 'Group automatic stacks' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
        userPreferencesUpdateDto: expect.objectContaining({ stacks: { groupAuto: false } }),
      }),
    );
    expect(authManager.preferences.stacks.groupAuto).toBe(false);
  });

  it('saves the automatic stacks preference', async () => {
    const preferences = preferencesFactory.build({ autoStack: { enabled: false } });
    authManager.setPreferences(preferences);
    sdkMock.updateMyPreferences.mockResolvedValue({ ...preferences, autoStack: { enabled: true } });
    const user = userEvent.setup();

    render(FeatureSettings);

    const toggle = screen.getByRole('switch', { name: 'Stack similar photos automatically' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
        userPreferencesUpdateDto: expect.objectContaining({ autoStack: { enabled: true } }),
      }),
    );
    expect(authManager.preferences.autoStack.enabled).toBe(true);
  });
});
