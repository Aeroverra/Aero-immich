import { PersistedLocalStorage } from '$lib/utils/persisted';

/** How many recently applied tags the picker offers as one click chips */
const RECENT_TAG_COUNT = 8;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * State shared by every tag picker, kept in the browser: the tags opened in the tree (by id, so a rename keeps them
 * open), so the commonly used branches stay open from one asset to the next, the recently applied tags, and whether
 * the picker in the viewer's detail panel is open.
 */
export const tagPicker = {
  expanded: new PersistedLocalStorage<string[]>('tag-picker-expanded', [], { valid: isStringArray }),
  recent: new PersistedLocalStorage<string[]>('tag-picker-recent', [], { valid: isStringArray }),
  isOpen: new PersistedLocalStorage<boolean>('tag-picker-open', false),
};

/** When the tag shortcut last asked for the search field of the detail panel picker */
export const tagPickerFocus = $state({ requestedAt: 0 });

export const rememberRecentTags = (tagIds: string[]) => {
  tagPicker.recent.current = [...tagIds, ...tagPicker.recent.current.filter((id) => !tagIds.includes(id))].slice(
    0,
    RECENT_TAG_COUNT,
  );
};
