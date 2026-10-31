import { goto } from '$app/navigation';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
import { searchManager } from '$lib/managers/search-manager.svelte';

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));

const submittedQuery = () => {
  const href = vi.mocked(goto).mock.lastCall?.[0] as string;
  const query = new URL(href, 'http://localhost').searchParams.get('query');
  return query ? (JSON.parse(query) as Record<string, unknown>) : {};
};

describe('SearchManager private filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    privateModeManager.enabled = true;
    searchManager.reset();
  });

  afterEach(() => {
    privateModeManager.enabled = false;
    searchManager.reset();
  });

  it('defaults to all assets', async () => {
    await searchManager.submit();

    expect(searchManager.filter.isPrivate).toBeUndefined();
    expect(submittedQuery()).not.toHaveProperty('isPrivate');
  });

  it('submits isPrivate true for only private', async () => {
    searchManager.filter.isPrivate = true;

    await searchManager.submit();

    expect(submittedQuery()).toMatchObject({ isPrivate: true });
  });

  it('submits isPrivate false for not private', async () => {
    searchManager.filter.isPrivate = false;

    await searchManager.submit();

    expect(submittedQuery()).toMatchObject({ isPrivate: false });
  });

  it('reads the private filter back from a query while the mode is on', () => {
    searchManager.setQuery({ isPrivate: false });

    expect(searchManager.filter.isPrivate).toBe(false);
  });

  it('ignores the private filter in a query while the mode is off', () => {
    privateModeManager.enabled = false;

    searchManager.setQuery({ isPrivate: true });

    expect(searchManager.filter.isPrivate).toBeUndefined();
  });

  it('never submits the private filter while the mode is off', async () => {
    searchManager.filter.isPrivate = true;
    privateModeManager.enabled = false;

    await searchManager.submit();

    expect(submittedQuery()).not.toHaveProperty('isPrivate');
  });

  it('drops the private filter when the mode turns off', () => {
    searchManager.filter.isPrivate = true;

    eventManager.emit('PrivateModeChange', false);

    expect(searchManager.filter.isPrivate).toBeUndefined();
  });

  it('keeps the private filter when the mode turns on', () => {
    searchManager.filter.isPrivate = false;

    eventManager.emit('PrivateModeChange', true);

    expect(searchManager.filter.isPrivate).toBe(false);
  });
});
