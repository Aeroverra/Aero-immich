import { DateTime } from 'luxon';
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

describe('SearchManager excluded tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchManager.reset();
  });

  afterEach(() => {
    searchManager.reset();
  });

  it('reads excluded tags from a query and submits them with the included tags', async () => {
    searchManager.setQuery({ tagIds: ['work'], excludeTagIds: ['holiday'] });

    expect([...searchManager.filter.excludeTagIds]).toEqual(['holiday']);
    await searchManager.submit();
    expect(submittedQuery()).toMatchObject({ tagIds: ['work'], excludeTagIds: ['holiday'] });
  });

  it('drops excluded tags while searching for untagged assets', async () => {
    searchManager.setQuery({ tagIds: null, excludeTagIds: ['holiday'] });

    await searchManager.submit();

    expect(submittedQuery()).toMatchObject({ tagIds: null });
    expect(submittedQuery()).not.toHaveProperty('excludeTagIds');
  });
});

describe('SearchManager video length', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchManager.reset();
  });

  afterEach(() => {
    searchManager.reset();
  });

  it('reads the length bounds from a query and submits them', async () => {
    searchManager.setQuery({ minDuration: 30_000, maxDuration: 300_000 });

    expect(searchManager.filter.minDuration).toBe(30_000);
    await searchManager.submit();
    expect(submittedQuery()).toMatchObject({ minDuration: 30_000, maxDuration: 300_000 });
  });
});

describe('SearchManager albums and upload date', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchManager.reset();
  });

  afterEach(() => {
    searchManager.reset();
  });

  it('reads albums from a query and submits them', async () => {
    searchManager.setQuery({ albumIds: ['trip'], excludeAlbumIds: ['party'] });

    expect([...searchManager.filter.albumIds]).toEqual(['trip']);
    expect([...searchManager.filter.excludeAlbumIds]).toEqual(['party']);
    await searchManager.submit();
    expect(submittedQuery()).toMatchObject({ albumIds: ['trip'], excludeAlbumIds: ['party'] });
  });

  it('drops the albums while searching for assets outside every album', async () => {
    searchManager.setQuery({ albumIds: ['trip'], excludeAlbumIds: ['party'], isNotInAlbum: true });

    await searchManager.submit();

    expect(submittedQuery()).toMatchObject({ isNotInAlbum: true });
    expect(submittedQuery()).not.toHaveProperty('albumIds');
    expect(submittedQuery()).not.toHaveProperty('excludeAlbumIds');
  });

  it('sends the picked upload days as local midnight to local midnight and reads them back', async () => {
    searchManager.filter.date.uploadedAfter = DateTime.utc(2019, 3, 1);
    searchManager.filter.date.uploadedBefore = DateTime.utc(2019, 3, 31);

    await searchManager.submit();

    const query = submittedQuery() as { uploadedAfter: string; uploadedBefore: string };
    expect(query.uploadedAfter).toBe(DateTime.local(2019, 3, 1).startOf('day').toUTC().toISO());
    expect(query.uploadedBefore).toBe(DateTime.local(2019, 3, 31).endOf('day').toUTC().toISO());
    expect(query).not.toHaveProperty('takenAfter');

    searchManager.setQuery(query);

    expect(searchManager.filter.date.uploadedAfter?.toISODate()).toBe('2019-03-01');
    expect(searchManager.filter.date.uploadedBefore?.toISODate()).toBe('2019-03-31');
  });
});

describe('SearchManager people and faces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchManager.reset();
  });

  afterEach(() => {
    searchManager.reset();
  });

  it('reads both sides of the face options from a query and submits them', async () => {
    searchManager.setQuery({ personIds: ['ann'], onlyPersonIds: false, hasUnnamedFaces: false, hasNamedFaces: true });

    expect(searchManager.filter.onlyPersonIds).toBe(false);
    expect(searchManager.filter.hasUnnamedFaces).toBe(false);
    expect(searchManager.filter.hasNamedFaces).toBe(true);
    expect(searchManager.filter.hasPeople).toBeUndefined();
    await searchManager.submit();
    expect(submittedQuery()).toEqual({
      personIds: ['ann'],
      onlyPersonIds: false,
      hasUnnamedFaces: false,
      hasNamedFaces: true,
    });
  });

  it('only sends only these people with people picked', async () => {
    searchManager.filter.onlyPersonIds = true;

    await searchManager.submit();

    expect(submittedQuery()).not.toHaveProperty('onlyPersonIds');
  });

  it('drops every other face option while searching for photos without people', async () => {
    searchManager.setQuery({
      personIds: ['ann'],
      onlyPersonIds: true,
      hasUnnamedFaces: true,
      hasNamedFaces: false,
      hasPeople: false,
    });

    await searchManager.submit();

    expect(submittedQuery()).toEqual({ hasPeople: false });
  });

  it('drops the people but keeps unnamed faces while searching for photos without anyone named', async () => {
    searchManager.setQuery({ personIds: ['ann'], onlyPersonIds: true, hasUnnamedFaces: true, hasNamedFaces: false });

    await searchManager.submit();

    expect(submittedQuery()).toEqual({ hasNamedFaces: false, hasUnnamedFaces: true });
  });

  it('sends with people alone', async () => {
    searchManager.filter.hasPeople = true;

    await searchManager.submit();

    expect(submittedQuery()).toEqual({ hasPeople: true });
  });
});
