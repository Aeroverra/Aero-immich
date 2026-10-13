import { getAllPeople, type AlbumResponseDto, type PersonResponseDto, type TagResponseDto } from '@immich/sdk';
import { DateTime } from 'luxon';
import { t } from 'svelte-i18n';
import type { SvelteSet } from 'svelte/reactivity';
import { get } from 'svelte/store';
import { MediaType } from '$lib/constants';
import type { SearchDateFilter, SearchFilter } from '$lib/types';
import { handleError } from '$lib/utils/handle-error';

export enum SearchDatePreset {
  ThisYear,
  LastYear,
  Last30Days,
  Custom,
}

export const getSearchDatePreset = (after: DateTime | undefined, before: DateTime | undefined) => {
  if (!after && !before) {
    return;
  }

  const start = after?.toMillis();
  const end = before?.endOf('day').toMillis();

  if (start === DateTime.utc().startOf('year').toMillis() && end === DateTime.utc().endOf('year').toMillis()) {
    return SearchDatePreset.ThisYear;
  }

  if (
    start === DateTime.utc().minus({ years: 1 }).startOf('year').toMillis() &&
    end === DateTime.utc().minus({ years: 1 }).endOf('year').toMillis()
  ) {
    return SearchDatePreset.LastYear;
  }

  if (
    start === DateTime.utc().minus({ days: 30 }).startOf('day').toMillis() &&
    end === DateTime.utc().endOf('day').toMillis()
  ) {
    return SearchDatePreset.Last30Days;
  }

  return SearchDatePreset.Custom;
};

export const getSearchDateRange = (after: DateTime | undefined, before: DateTime | undefined) => {
  const $t = get(t);
  const start = after?.toLocaleString(DateTime.DATE_MED);
  const end = before?.toLocaleString(DateTime.DATE_MED);
  return start && end ? $t('search_filter_date_interval', { values: { start, end } }) : (start ?? end);
};

export const getSearchDateTitle = (
  preset: SearchDatePreset | undefined,
  before: DateTime | undefined,
  after: DateTime | undefined,
): string | undefined => {
  const $t = get(t);
  switch (preset) {
    case SearchDatePreset.ThisYear: {
      return $t('search_filter_date_this_year');
    }
    case SearchDatePreset.LastYear: {
      return $t('search_filter_date_last_year');
    }
    case SearchDatePreset.Last30Days: {
      return $t('search_filter_date_last_30_days');
    }
    case SearchDatePreset.Custom: {
      return getSearchDateRange(before, after);
    }
    default: {
      return;
    }
  }
};

/** The Date filter title: the taken range, then the upload range */
export const getSearchDateFilterTitle = (date: SearchDateFilter) => {
  const $t = get(t);
  const taken = getSearchDateTitle(
    getSearchDatePreset(date.takenAfter, date.takenBefore),
    date.takenAfter,
    date.takenBefore,
  );
  const uploaded = getSearchDateTitle(
    getSearchDatePreset(date.uploadedAfter, date.uploadedBefore),
    date.uploadedAfter,
    date.uploadedBefore,
  );
  const titles = [taken, uploaded && $t('search_uploaded_range', { values: { range: uploaded } })];
  return titles.filter(Boolean).join(' · ') || undefined;
};

export const getSearchTypeTitle = (type: string) => {
  const $t = get(t);
  switch (type) {
    case 'metadata': {
      return $t('file_name_text');
    }
    case 'description': {
      return $t('description');
    }
    case 'fullPath': {
      return $t('full_path_or_folder');
    }
    case 'ocr': {
      return $t('ocr');
    }
    default: {
      return;
    }
  }
};

export const getSearchTypePlaceholder = (type: string) => {
  const $t = get(t);
  switch (type) {
    case 'metadata': {
      return $t('search_by_filename_example');
    }
    case 'description': {
      return $t('search_by_description_example');
    }
    case 'fullPath': {
      return $t('search_by_full_path_example');
    }
    case 'ocr': {
      return $t('search_by_ocr_example');
    }
    case 'smart': {
      return $t('search_by_context_example');
    }
    default: {
      return $t('search_your_photos');
    }
  }
};

export const getSearchPlacesTitle = (city?: string, state?: string, country?: string) =>
  [city, state, country].filter(Boolean).join(', ') || undefined;

/** A video length typed as seconds, m:ss or h:mm:ss, in milliseconds; undefined when empty, null when not a length */
export const parseVideoLength = (text: string): number | null | undefined => {
  const value = text.trim();
  if (!value) {
    return undefined;
  }
  if (!/^\d+(:\d{1,2}){0,2}$/.test(value)) {
    return null;
  }
  const seconds = value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  return seconds * 1000;
};

/** A video length in milliseconds as m:ss, or h:mm:ss from an hour on */
export const formatVideoLength = (milliseconds: number) => {
  const total = Math.round(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
};

/** "0:30 to 5:00", "0:30 or longer" or "Up to 5:00"; undefined without bounds */
export const getVideoLengthTitle = (minDuration?: number, maxDuration?: number) => {
  const $t = get(t);
  if (minDuration !== undefined && maxDuration !== undefined) {
    return $t('search_video_length_range', {
      values: { shortest: formatVideoLength(minDuration), longest: formatVideoLength(maxDuration) },
    });
  }
  if (minDuration !== undefined) {
    return $t('search_video_length_at_least', { values: { duration: formatVideoLength(minDuration) } });
  }
  if (maxDuration !== undefined) {
    return $t('search_video_length_at_most', { values: { duration: formatVideoLength(maxDuration) } });
  }
};

export const getSearchMediaTitle = (mediaType: MediaType, minDuration?: number, maxDuration?: number) => {
  const $t = get(t);
  const length = getVideoLengthTitle(minDuration, maxDuration);
  if (length) {
    return `${$t('video')} ${length}`;
  }
  switch (mediaType) {
    case MediaType.Image: {
      return $t('image');
    }
    case MediaType.Video: {
      return $t('video');
    }
    default: {
      return;
    }
  }
};

export const getPeople = async (selected: SvelteSet<string>): Promise<PersonResponseDto[]> => {
  const $t = get(t);
  try {
    const res = await getAllPeople({ withHidden: false });
    res.people.sort((a, b) => (selected.has(a.id) ? -1 : selected.has(b.id) ? 1 : 0));
    return res.people;
  } catch (error) {
    handleError(error, $t('errors.failed_to_get_people'));
  }
  return [];
};

export const getSearchPeopleTitle = (people: PersonResponseDto[], selected: SvelteSet<string>) => {
  if (selected.size === 0) {
    return;
  }

  const $t = get(t);

  const name = people.find(({ id, name }) => name && selected.has(id))?.name;
  if (name) {
    return selected.size === 1 ? name : $t('name_plus_more_people', { values: { name, count: selected.size - 1 } });
  }

  return $t('people_count', { values: { count: selected.size } });
};

/** The People filter title: [names] from {@link getSearchPeopleTitle}, with the face options */
export const getSearchPeopleFilterTitle = (
  names: string | undefined,
  {
    onlyPersonIds,
    hasPeople,
    hasNamedFaces,
    hasUnnamedFaces,
  }: Pick<SearchFilter, 'onlyPersonIds' | 'hasPeople' | 'hasNamedFaces' | 'hasUnnamedFaces'>,
) => {
  const $t = get(t);

  if (hasPeople === false) {
    return $t('search_filter_no_people');
  }

  let people: string | undefined;
  if (hasNamedFaces === false) {
    people = $t('search_filter_no_named_people');
  } else if (names) {
    people =
      onlyPersonIds === undefined
        ? names
        : $t(onlyPersonIds ? 'search_filter_only_people_title' : 'search_filter_with_others_title', {
            values: { people: names },
          });
  } else if (hasNamedFaces) {
    people = $t('search_filter_with_named_people');
  }

  const unnamed =
    hasUnnamedFaces === undefined
      ? undefined
      : $t(hasUnnamedFaces ? 'search_filter_with_unnamed_faces' : 'search_filter_no_unnamed_faces');
  const parts = [people, unnamed].filter(Boolean);
  // anyone at all is implied by every other option
  if (parts.length === 0 && hasPeople) {
    return $t('search_filter_with_people');
  }
  return parts.join(' · ') || undefined;
};

export const getSearchTagsTitle = (
  tags: TagResponseDto[],
  selected: SvelteSet<string>,
  excluded: ReadonlySet<string> = new Set(),
) => {
  const $t = get(t);

  const title = (ids: ReadonlySet<string>) => {
    const id = ids.values().next().value;
    const tag = id ? tags.find((t) => t.id === id)?.name : undefined;
    if (!tag) {
      return undefined;
    }
    return ids.size === 1 ? tag : $t('tag_plus_more_tags', { values: { tag, count: ids.size - 1 } });
  };

  const without = title(excluded);
  return title(selected) ?? (without ? $t('search_without_tag', { values: { tag: without } }) : undefined);
};

export const getSearchAlbumsTitle = (
  albums: AlbumResponseDto[],
  selected: ReadonlySet<string>,
  excluded: ReadonlySet<string> = new Set(),
) => {
  const $t = get(t);

  const title = (ids: ReadonlySet<string>) => {
    const id = ids.values().next().value;
    const album = id ? albums.find((album) => album.id === id)?.albumName : undefined;
    if (album === undefined) {
      return undefined;
    }
    return ids.size === 1 ? album : $t('search_album_plus_more_albums', { values: { album, count: ids.size - 1 } });
  };

  const without = title(excluded);
  return (
    [title(selected), without && $t('search_not_in_album', { values: { album: without } })]
      .filter(Boolean)
      .join(' · ') || undefined
  );
};

export const isPopoverContent = (event: FocusEvent): boolean => {
  const element = event.relatedTarget;
  return element instanceof Element && element.closest('[data-popover-content]') !== null;
};
