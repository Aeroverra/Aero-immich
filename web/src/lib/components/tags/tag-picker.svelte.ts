import { PersistedLocalStorage } from '$lib/utils/persisted';
import { togglePinnedTag } from '$lib/utils/pinned-tags';

/** How many recently applied tags the picker offers as one click chips */
const RECENT_TAG_COUNT = 8;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Reads a damaged stored value as no value, so a bad entry cannot break the page */
const safeJson = {
  stringify: (value: unknown) => JSON.stringify(value),
  parse: (text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      return;
    }
  },
};

/**
 * State shared by every tag picker, kept in the browser: the tags opened in the tree (by id, so a rename keeps them
 * open), so the commonly used branches stay open from one asset to the next, the recently applied tags, and whether
 * the picker in the viewer's detail panel is open.
 */
export const tagPicker = {
  expanded: new PersistedLocalStorage<string[]>('tag-picker-expanded', [], { valid: isStringArray }),
  recent: new PersistedLocalStorage<string[]>('tag-picker-recent', [], { valid: isStringArray }),
  isOpen: new PersistedLocalStorage<boolean>('tag-picker-open', false),
  /** the tags pinned to the selection bar, by id, in pin order */
  pinned: new PersistedLocalStorage<string[]>('tag-picker-pinned', [], { valid: isStringArray, serializer: safeJson }),
};

export const togglePinned = (tagId: string) => {
  try {
    tagPicker.pinned.current = togglePinnedTag(tagPicker.pinned.current, tagId);
  } catch {
    // the browser refused to store it (private window, quota); the pin is not kept
  }
};

/**
 * How many tag actions are on the page right now. The selection bar offers the pinned tags only while the page
 * offers tagging the selection (the tags feature is on and the selected assets can be tagged).
 */
export const pinnedTagsBar = $state({ hosts: 0 });

/** When the tag shortcut last asked for the search field of the detail panel picker */
export const tagPickerFocus = $state({ requestedAt: 0 });

/** The search of the detail panel picker, kept while the viewer closes and opens other assets */
export const tagPickerSearch = $state({ query: '' });

export const rememberRecentTags = (tagIds: string[]) => {
  tagPicker.recent.current = [...tagIds, ...tagPicker.recent.current.filter((id) => !tagIds.includes(id))].slice(
    0,
    RECENT_TAG_COUNT,
  );
};
