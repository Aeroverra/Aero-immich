import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import SearchFilters from '$lib/components/shared-components/search-bar/SearchFilters.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
import { searchManager } from '$lib/managers/search-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), function () {
  return {
    featureFlagsManager: { init: vi.fn(), loadFeatureFlags: vi.fn(), value: { smartSearch: true } } as never,
  };
});

describe('SearchFilters component', () => {
  const renderFilters = () =>
    render(SearchFilters, {
      props: {
        id: 'search-filters',
        isOpen: true,
        onSelectSearchTerm: vi.fn(),
        onClearSearchTerm: vi.fn(),
        onClearAllSearchTerms: vi.fn(),
        onActiveSelectionChange: vi.fn(),
        onSearch: vi.fn(),
      },
    });

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    sdkMock.getSearchSuggestions.mockResolvedValue([]);
    authManager.setUser(userAdminFactory.build());
    authManager.setPreferences(preferencesFactory.build());
    searchManager.reset();
  });

  afterEach(() => {
    privateModeManager.enabled = false;
    authManager.reset();
    searchManager.reset();
  });

  it('hides the private row while private mode is off', () => {
    privateModeManager.enabled = false;

    renderFilters();

    expect(screen.queryByText('search_private_filter')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'search_private_only' })).not.toBeInTheDocument();
  });

  it('shows the private row with all three options while private mode is on', () => {
    privateModeManager.enabled = true;

    renderFilters();

    expect(screen.getByText('search_private_filter')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'search_private_all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'search_private_only' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'search_private_exclude' })).toBeInTheDocument();
  });

  it('maps the options onto the private filter', async () => {
    privateModeManager.enabled = true;
    const user = userEvent.setup();

    renderFilters();

    await user.click(screen.getByRole('button', { name: 'search_private_only' }));
    expect(searchManager.filter.isPrivate).toBe(true);

    await user.click(screen.getByRole('button', { name: 'search_private_exclude' }));
    expect(searchManager.filter.isPrivate).toBe(false);

    await user.click(screen.getByRole('button', { name: 'search_private_all' }));
    expect(searchManager.filter.isPrivate).toBeUndefined();
  });
});
