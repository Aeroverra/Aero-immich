import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import SearchDisplaySection from '$lib/components/shared-components/search-bar/SearchDisplaySection.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { searchManager } from '$lib/managers/search-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

describe('SearchDisplaySection component', () => {
  beforeEach(() => {
    authManager.setUser(userAdminFactory.build());
    authManager.setPreferences(preferencesFactory.build({ tags: { enabled: true, sidebarWeb: true } }));
    searchManager.reset();
  });

  afterEach(() => {
    authManager.reset();
    searchManager.reset();
  });

  it('toggles the not-in-album filter', async () => {
    const user = userEvent.setup();
    render(SearchDisplaySection);

    await user.click(screen.getByRole('button', { name: 'search_filter_display_option_not_in_album' }));
    expect(searchManager.filter.display.isNotInAlbum).toBe(true);

    await user.click(screen.getByRole('button', { name: 'search_filter_display_option_not_in_album' }));
    expect(searchManager.filter.display.isNotInAlbum).toBe(false);
  });

  it('toggles the no-tags filter by clearing and restoring the tag selection', async () => {
    const user = userEvent.setup();
    searchManager.setQuery({ tagIds: ['tag-1'] });
    render(SearchDisplaySection);

    await user.click(screen.getByRole('button', { name: 'search_filter_display_option_no_tags' }));
    expect(searchManager.filter.tagIds).toBeNull();

    await user.click(screen.getByRole('button', { name: 'search_filter_display_option_no_tags' }));
    expect([...(searchManager.filter.tagIds ?? [])]).toEqual([]);
  });

  it('restores the no-tags filter from the query', () => {
    searchManager.setQuery({ tagIds: null });
    render(SearchDisplaySection);

    expect(searchManager.filter.tagIds).toBeNull();
    expect(screen.getByRole('button', { name: 'search_filter_display_option_no_tags' })).toBeInTheDocument();
  });

  it('hides the no-tags filter when tags are disabled', () => {
    authManager.setPreferences(preferencesFactory.build({ tags: { enabled: false, sidebarWeb: false } }));
    render(SearchDisplaySection);

    expect(screen.queryByRole('button', { name: 'search_filter_display_option_no_tags' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'search_filter_display_option_not_in_album' })).toBeInTheDocument();
  });
});
