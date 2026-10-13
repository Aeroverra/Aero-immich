import {
  DeletedReimportMode,
  deleteMyDeletedChecksums,
  getMyDeletedChecksumStatistics,
  updateMyPreferences,
} from '@immich/sdk';
import { modalManager } from '@immich/ui';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import PreviouslyDeletedSettings from './PreviouslyDeletedSettings.svelte';

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return {
    ...sdk,
    getMyDeletedChecksumStatistics: vi.fn(),
    updateMyPreferences: vi.fn(),
    deleteMyDeletedChecksums: vi.fn(),
  };
});

describe('PreviouslyDeletedSettings', () => {
  beforeEach(() => {
    authManager.setUser(userAdminFactory.build());
    authManager.setPreferences(
      preferencesFactory.build({ deletedReimport: { mode: DeletedReimportMode.Album, albumId: null } }),
    );
    vi.mocked(getMyDeletedChecksumStatistics).mockResolvedValue({ count: 3 });
  });

  afterEach(() => {
    authManager.reset();
    vi.clearAllMocks();
  });

  it('shows how many files are remembered', async () => {
    render(PreviouslyDeletedSettings);

    await waitFor(() => expect(screen.getByRole('button', { name: 'previously_deleted_forget_all' })).toBeEnabled());
    expect(getMyDeletedChecksumStatistics).toHaveBeenCalledOnce();
    expect(screen.getByText('previously_deleted_remembered_files')).toBeInTheDocument();
  });

  it('disables the forget button when nothing is remembered', async () => {
    vi.mocked(getMyDeletedChecksumStatistics).mockResolvedValue({ count: 0 });

    render(PreviouslyDeletedSettings);

    await waitFor(() => expect(getMyDeletedChecksumStatistics).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'previously_deleted_forget_all' })).toBeDisabled();
  });

  it('saves the current mode as a preference', async () => {
    const preferences = preferencesFactory.build({
      deletedReimport: { mode: DeletedReimportMode.Album, albumId: 'album-id' },
    });
    vi.mocked(updateMyPreferences).mockResolvedValue(preferences);
    const user = userEvent.setup();

    render(PreviouslyDeletedSettings);

    await user.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(updateMyPreferences).toHaveBeenCalledWith({
        userPreferencesUpdateDto: { deletedReimport: { mode: DeletedReimportMode.Album } },
      }),
    );
    expect(authManager.preferences.deletedReimport.albumId).toBe('album-id');
  });

  it('forgets every remembered file after confirmation', async () => {
    vi.spyOn(modalManager, 'showDialog').mockResolvedValue(true);
    vi.mocked(deleteMyDeletedChecksums).mockResolvedValue(undefined as never);
    const user = userEvent.setup();

    render(PreviouslyDeletedSettings);

    const button = screen.getByRole('button', { name: 'previously_deleted_forget_all' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() => expect(deleteMyDeletedChecksums).toHaveBeenCalledOnce());
    expect(button).toBeDisabled();
  });

  it('keeps the remembered files when the confirmation is declined', async () => {
    vi.spyOn(modalManager, 'showDialog').mockResolvedValue(false);
    const user = userEvent.setup();

    render(PreviouslyDeletedSettings);

    const button = screen.getByRole('button', { name: 'previously_deleted_forget_all' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    expect(deleteMyDeletedChecksums).not.toHaveBeenCalled();
    expect(button).toBeEnabled();
  });
});
