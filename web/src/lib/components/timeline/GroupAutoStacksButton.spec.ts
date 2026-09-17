import '@testing-library/jest-dom';
import { cleanup, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import GroupAutoStacksButton from './GroupAutoStacksButton.svelte';

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), () => ({
  featureFlagsManager: { init: vi.fn(), value: { stackSource: true } } as never,
}));

describe('GroupAutoStacksButton component', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    featureFlagsManager.value.stackSource = true;
    authManager.setUser(userAdminFactory.build());
  });

  afterEach(() => {
    cleanup();
    authManager.reset();
  });

  it('reflects the preference', () => {
    authManager.setPreferences(preferencesFactory.build({ stacks: { groupAuto: false } }));

    renderWithTooltips(GroupAutoStacksButton, {});

    const button = screen.getByRole('button', { name: 'Group automatic stacks' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('saves the opposite value right away', async () => {
    const preferences = preferencesFactory.build({ stacks: { groupAuto: true } });
    authManager.setPreferences(preferences);
    sdkMock.updateMyPreferences.mockResolvedValue({ ...preferences, stacks: { groupAuto: false } });
    const user = userEvent.setup();

    renderWithTooltips(GroupAutoStacksButton, {});

    const button = screen.getByRole('button', { name: 'Group automatic stacks' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    await user.click(button);

    expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
      userPreferencesUpdateDto: { stacks: { groupAuto: false } },
    });
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'false'));
    expect(authManager.preferences.stacks.groupAuto).toBe(false);
  });

  it('is hidden when the server does not know the stack source', () => {
    featureFlagsManager.value.stackSource = undefined;
    authManager.setPreferences(preferencesFactory.build());

    renderWithTooltips(GroupAutoStacksButton, {});

    expect(screen.queryByRole('button', { name: 'Group automatic stacks' })).not.toBeInTheDocument();
  });
});
