import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import SearchAlbumsSection from '$lib/components/shared-components/search-bar/SearchAlbumsSection.svelte';
import { searchManager } from '$lib/managers/search-manager.svelte';
import { albumFactory } from '@test-data/factories/album-factory';

const albums = [
  albumFactory.build({ id: 'album-1', albumName: 'Trip' }),
  albumFactory.build({ id: 'album-2', albumName: 'Party' }),
];

describe('SearchAlbumsSection component', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
  });

  afterEach(() => {
    searchManager.reset();
  });

  it('adds an album to search in from the first box', async () => {
    const user = userEvent.setup();
    render(SearchAlbumsSection, { props: { albums } });

    await user.type(screen.getByRole('combobox', { name: 'search_include_albums' }), 'Tri');
    await user.keyboard('{Enter}');

    expect([...searchManager.filter.albumIds]).toEqual(['album-1']);
    expect(await screen.findByRole('button', { name: 'Trip' })).toBeInTheDocument();
  });

  it('moves an album to the left out albums from the second box', async () => {
    const user = userEvent.setup();
    searchManager.setQuery({ albumIds: ['album-2'] });
    render(SearchAlbumsSection, { props: { albums } });

    await user.type(screen.getByRole('combobox', { name: 'search_exclude_albums' }), 'Par');
    await user.keyboard('{Enter}');

    expect([...searchManager.filter.excludeAlbumIds]).toEqual(['album-2']);
    expect(searchManager.filter.albumIds.size).toBe(0);
  });

  it('removes a left out album when its chip is clicked and keeps focus in the section', async () => {
    const user = userEvent.setup();
    searchManager.setQuery({ albumIds: ['album-1'], excludeAlbumIds: ['album-2'] });
    const { container } = render(SearchAlbumsSection, { props: { albums } });

    // i18n is not loaded here: the label is the key
    await user.click(await screen.findByRole('button', { name: 'search_not_in_album' }));

    expect(searchManager.filter.excludeAlbumIds.size).toBe(0);
    expect([...searchManager.filter.albumIds]).toEqual(['album-1']);
    expect(container.contains(document.activeElement)).toBe(true);
  });

  it('turns "not in any album" on and off, and leaves the album boxes out while it is on', async () => {
    const user = userEvent.setup();
    searchManager.setQuery({ albumIds: ['album-1'] });
    render(SearchAlbumsSection, { props: { albums } });

    await user.click(screen.getByRole('button', { name: 'not_in_any_album' }));

    expect(searchManager.filter.display.isNotInAlbum).toBe(true);
    expect(screen.getByRole('combobox', { name: 'search_include_albums' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Trip' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'not_in_any_album' }));

    expect(searchManager.filter.display.isNotInAlbum).toBe(false);
    expect(screen.getByRole('button', { name: 'Trip' })).toBeInTheDocument();
  });
});
