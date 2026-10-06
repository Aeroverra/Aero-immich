import type { PersonResponseDto } from '@immich/sdk';
import { DateTime } from 'luxon';
import {
  formatVideoLength,
  getSearchAlbumsTitle,
  getSearchDateFilterTitle,
  getSearchExcludedPeopleTitle,
  getSearchPeopleFilterTitle,
  isPopoverContent,
  parseVideoLength,
} from '$lib/components/shared-components/search-bar/search-bar-utils';
import { albumFactory } from '@test-data/factories/album-factory';

describe('isPopoverContent', () => {
  const focusOutEventTo = (relatedTarget: EventTarget | null) => new FocusEvent('focusout', { relatedTarget });

  const createCalendarPopup = () => {
    const popup = document.createElement('div');
    popup.dataset.popoverContent = '';
    return popup;
  };

  it('returns true when focus moves to an element inside a calendar popup', () => {
    const popup = createCalendarPopup();
    const dayButton = document.createElement('button');
    popup.append(dayButton);

    expect(isPopoverContent(focusOutEventTo(dayButton))).toBe(true);
  });

  it('returns true when focus moves to the calendar popup itself', () => {
    const popup = createCalendarPopup();

    expect(isPopoverContent(focusOutEventTo(popup))).toBe(true);
  });

  it('returns false when focus moves to an element outside a calendar popup', () => {
    const button = document.createElement('button');

    expect(isPopoverContent(focusOutEventTo(button))).toBe(false);
  });

  it('returns false when focus does not move to another element', () => {
    expect(isPopoverContent(focusOutEventTo(null))).toBe(false);
  });
});

describe('video length', () => {
  it('reads seconds, m:ss and h:mm:ss as milliseconds', () => {
    expect(parseVideoLength('45')).toBe(45_000);
    expect(parseVideoLength(' 1:30 ')).toBe(90_000);
    expect(parseVideoLength('1:02:03')).toBe(3_723_000);
    expect(parseVideoLength('')).toBeUndefined();
  });

  it('refuses what is not a length', () => {
    expect(parseVideoLength('1.5')).toBeNull();
    expect(parseVideoLength('abc')).toBeNull();
    expect(parseVideoLength('1:2:3:4')).toBeNull();
  });

  it('writes lengths as m:ss, or h:mm:ss from an hour on', () => {
    expect(formatVideoLength(5000)).toBe('0:05');
    expect(formatVideoLength(90_000)).toBe('1:30');
    expect(formatVideoLength(3_723_000)).toBe('1:02:03');
  });
});

// i18n is not loaded here: translated parts come back as their keys
describe('getSearchAlbumsTitle', () => {
  const albums = [
    albumFactory.build({ id: 'trip', albumName: 'Trip' }),
    albumFactory.build({ id: 'party', albumName: 'Party' }),
  ];

  it('names a single searched album', () => {
    expect(getSearchAlbumsTitle(albums, new Set(['trip']))).toBe('Trip');
  });

  it('adds the left out albums after the searched ones', () => {
    expect(getSearchAlbumsTitle(albums, new Set(['trip']), new Set(['party']))).toBe('Trip · search_not_in_album');
  });

  it('counts further albums and has no title without albums', () => {
    expect(getSearchAlbumsTitle(albums, new Set(['trip', 'party']))).toBe('search_album_plus_more_albums');
    expect(getSearchAlbumsTitle(albums, new Set())).toBeUndefined();
    expect(getSearchAlbumsTitle([], new Set(['trip']))).toBeUndefined();
  });
});

describe('getSearchPeopleFilterTitle', () => {
  it('names the people and the side of each face option', () => {
    expect(getSearchPeopleFilterTitle('Ann', undefined, {})).toBe('Ann');
    expect(getSearchPeopleFilterTitle('Ann', undefined, { onlyPersonIds: true })).toBe(
      'search_filter_only_people_title',
    );
    expect(getSearchPeopleFilterTitle('Ann', undefined, { onlyPersonIds: false })).toBe(
      'search_filter_with_others_title',
    );
    expect(getSearchPeopleFilterTitle('Ann', undefined, { hasUnnamedFaces: true })).toBe(
      'Ann · search_filter_with_unnamed_faces',
    );
    expect(getSearchPeopleFilterTitle(undefined, undefined, { hasUnnamedFaces: false })).toBe(
      'search_filter_no_unnamed_faces',
    );
    expect(getSearchPeopleFilterTitle(undefined, undefined, { hasNamedFaces: true })).toBe(
      'search_filter_with_named_people',
    );
  });

  it('says no people over everything else', () => {
    expect(
      getSearchPeopleFilterTitle('Ann', undefined, {
        onlyPersonIds: true,
        hasPeople: false,
        hasNamedFaces: false,
        hasUnnamedFaces: true,
      }),
    ).toBe('search_filter_no_people');
  });

  it('says no named people instead of the picked people', () => {
    expect(
      getSearchPeopleFilterTitle('Ann', undefined, {
        onlyPersonIds: true,
        hasNamedFaces: false,
        hasUnnamedFaces: true,
      }),
    ).toBe('search_filter_no_named_people · search_filter_with_unnamed_faces');
  });

  it('says with people only when nothing else is set', () => {
    expect(getSearchPeopleFilterTitle(undefined, undefined, { hasPeople: true })).toBe('search_filter_with_people');
    expect(getSearchPeopleFilterTitle('Ann', undefined, { hasPeople: true })).toBe('Ann');
  });

  it('has no title without people or options', () => {
    expect(getSearchPeopleFilterTitle(undefined, undefined, { onlyPersonIds: true })).toBeUndefined();
  });

  it('names the left out people after the picked ones', () => {
    expect(getSearchPeopleFilterTitle(undefined, 'Without Bob', {})).toBe('Without Bob');
    expect(getSearchPeopleFilterTitle('Ann', 'Without Bob', { hasUnnamedFaces: false })).toBe(
      'Ann · Without Bob · search_filter_no_unnamed_faces',
    );
  });

  it('leaves out the left out people when they do not apply', () => {
    expect(getSearchPeopleFilterTitle(undefined, 'Without Bob', { hasPeople: false })).toBe('search_filter_no_people');
    expect(getSearchPeopleFilterTitle(undefined, 'Without Bob', { hasNamedFaces: false })).toBe(
      'search_filter_no_named_people',
    );
  });
});

describe('getSearchExcludedPeopleTitle', () => {
  const people = [
    { id: 'ann', name: 'Ann' },
    { id: 'bob', name: 'Bob' },
  ] as PersonResponseDto[];

  it('says without the first left out person', () => {
    expect(getSearchExcludedPeopleTitle(people, new Set(['bob']))).toBe('search_without_person');
  });

  it('has no title without left out people', () => {
    expect(getSearchExcludedPeopleTitle(people, new Set())).toBeUndefined();
  });
});

describe('getSearchDateFilterTitle', () => {
  it('has no title without dates', () => {
    expect(getSearchDateFilterTitle({})).toBeUndefined();
  });

  it('names the taken range, then the upload range', () => {
    const title = getSearchDateFilterTitle({
      takenAfter: DateTime.utc().startOf('year'),
      takenBefore: DateTime.utc().endOf('year'),
      uploadedAfter: DateTime.utc(2019, 3, 1),
      uploadedBefore: DateTime.utc(2019, 3, 31),
    });

    expect(title).toBe('search_filter_date_this_year · search_uploaded_range');
  });

  it('names an upload range alone', () => {
    expect(getSearchDateFilterTitle({ uploadedAfter: DateTime.utc(2019, 3, 1) })).toBe('search_uploaded_range');
  });
});
