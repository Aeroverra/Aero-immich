import { goto } from '$app/navigation';
import { page } from '$app/state';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
import { searchManager } from '$lib/managers/search-manager.svelte';
import { Route } from '$lib/route';
import { renderWithTooltips } from '$tests/helpers';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import SearchPage from './+page.svelte';

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  afterNavigate: vi.fn(),
  invalidateAll: vi.fn(),
}));

vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/search'), route: { id: '/(user)/search' } },
}));

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), function () {
  return {
    featureFlagsManager: { init: vi.fn(), loadFeatureFlags: vi.fn(), value: { smartSearch: true } } as never,
  };
});

const emptyResults = {
  albums: { items: [], total: 0, count: 0, facets: [] },
  assets: { items: [], total: 0, count: 0, facets: [], nextPage: null, nextCursor: null },
};

const openSearch = (terms: Record<string, unknown>) => {
  page.url = new URL(Route.search(terms), 'http://localhost') as typeof page.url;
  return renderWithTooltips(SearchPage, {});
};

describe('Search page private filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    authManager.setUser(userAdminFactory.build());
    authManager.setPreferences(preferencesFactory.build());
    privateModeManager.enabled = true;
    sdkMock.searchAssets.mockResolvedValue(emptyResults);
    sdkMock.searchSmart.mockResolvedValue(emptyResults);
  });

  afterEach(() => {
    privateModeManager.enabled = false;
    authManager.reset();
    searchManager.reset();
  });

  it('sends isPrivate true to searchAssets for only private', async () => {
    openSearch({ originalFileName: 'IMG', isPrivate: true });

    await vi.waitFor(() => expect(sdkMock.searchAssets).toHaveBeenCalledOnce());
    expect(sdkMock.searchAssets.mock.lastCall?.[0].metadataSearchDto).toMatchObject({
      originalFileName: 'IMG',
      isPrivate: true,
    });
  });

  it('sends isPrivate false to searchAssets for not private', async () => {
    openSearch({ originalFileName: 'IMG', isPrivate: false });

    await vi.waitFor(() => expect(sdkMock.searchAssets).toHaveBeenCalledOnce());
    expect(sdkMock.searchAssets.mock.lastCall?.[0].metadataSearchDto).toMatchObject({ isPrivate: false });
  });

  it('omits isPrivate from searchAssets for all', async () => {
    openSearch({ originalFileName: 'IMG' });

    await vi.waitFor(() => expect(sdkMock.searchAssets).toHaveBeenCalledOnce());
    expect(sdkMock.searchAssets.mock.lastCall?.[0].metadataSearchDto).not.toHaveProperty('isPrivate');
  });

  it('sends isPrivate to searchSmart', async () => {
    openSearch({ query: 'beach', isPrivate: true });

    await vi.waitFor(() => expect(sdkMock.searchSmart).toHaveBeenCalledOnce());
    expect(sdkMock.searchSmart.mock.lastCall?.[0].smartSearchDto).toMatchObject({ query: 'beach', isPrivate: true });
    expect(sdkMock.searchAssets).not.toHaveBeenCalled();
  });

  it('drops the private filter and reruns without it when the mode turns off', async () => {
    openSearch({ originalFileName: 'IMG', isPrivate: true });
    await vi.waitFor(() => expect(sdkMock.searchAssets).toHaveBeenCalledOnce());

    privateModeManager.enabled = false;
    eventManager.emit('PrivateModeChange', false);

    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith(Route.search({ originalFileName: 'IMG' })));
    expect(searchManager.filter.isPrivate).toBeUndefined();
    expect(sdkMock.searchAssets).toHaveBeenCalledOnce();
  });

  it('strips a private filter from the URL when opened with the mode off', async () => {
    privateModeManager.enabled = false;

    openSearch({ originalFileName: 'IMG', isPrivate: true });

    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith(Route.search({ originalFileName: 'IMG' })));
    expect(sdkMock.searchAssets).not.toHaveBeenCalled();
  });

  it('reruns the search in place when the mode turns on', async () => {
    privateModeManager.enabled = false;
    openSearch({ originalFileName: 'IMG' });
    await vi.waitFor(() => expect(sdkMock.searchAssets).toHaveBeenCalledOnce());

    privateModeManager.enabled = true;
    eventManager.emit('PrivateModeChange', true);

    await vi.waitFor(() => expect(sdkMock.searchAssets).toHaveBeenCalledTimes(2));
    expect(goto).not.toHaveBeenCalled();
  });
});
