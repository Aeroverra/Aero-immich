import { StackActionMode, updateMyPreferences } from '@immich/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import StackActionsSettings from './StackActionsSettings.svelte';

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return {
    ...sdk,
    updateMyPreferences: vi.fn(),
  };
});

describe('StackActionsSettings', () => {
  beforeEach(() => {
    authManager.setUser(userAdminFactory.build());
    authManager.setPreferences(preferencesFactory.build({ stackActions: { mode: StackActionMode.Primary } }));
  });

  afterEach(() => {
    authManager.reset();
    vi.clearAllMocks();
  });

  it('saves the current choice to the user preferences', async () => {
    const updated = preferencesFactory.build({ stackActions: { mode: StackActionMode.Primary } });
    vi.mocked(updateMyPreferences).mockResolvedValue(updated);

    render(StackActionsSettings);
    await userEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(updateMyPreferences).toHaveBeenCalledExactlyOnceWith({
        userPreferencesUpdateDto: { stackActions: { mode: StackActionMode.Primary } },
      }),
    );
    expect(authManager.preferences).toEqual(updated);
  });

  it('shows the setting with its description', () => {
    render(StackActionsSettings);

    expect(screen.getByText('stack_actions_mode')).toBeInTheDocument();
    expect(screen.getByText('stack_actions_mode_description')).toBeInTheDocument();
  });
});
