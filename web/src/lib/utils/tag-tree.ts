import type { TagResponseDto } from '@immich/sdk';

/** The last part of a tag path */
export const tagName = (value: string) => value.slice(value.lastIndexOf('/') + 1);

/** The path of the parent tag, empty for a top level tag */
export const tagParentPath = (value: string) => {
  const index = value.lastIndexOf('/');
  return index === -1 ? '' : value.slice(0, index);
};

const compareNames = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export type TagRow = {
  tag: TagResponseDto;
  name: string;
  depth: number;
  hasChildren: boolean;
  isOpen: boolean;
  /** whether the row matches the search; the other rows while searching are the parents of matches */
  isMatch: boolean;
  /** how many tags below this one are checked, shown while it is closed */
  checkedBelow: number;
};

/**
 * The rows of the tag tree: every tag below an open parent, siblings by name. While searching, the tags whose path
 * contains every word of [query] show with their parents, all open.
 */
export const buildTagRows = (
  tags: TagResponseDto[],
  { expanded, checked, query = '' }: { expanded: ReadonlySet<string>; checked: ReadonlySet<string>; query?: string },
): TagRow[] => {
  const values = new Set(tags.map((tag) => tag.value));
  // a tag whose parent is missing (not synced yet, or hidden) is listed at the top level with its full path
  const parentOf = (tag: TagResponseDto) => {
    const parent = tagParentPath(tag.value);
    return values.has(parent) ? parent : '';
  };

  const children = new Map<string, TagResponseDto[]>();
  for (const tag of tags) {
    const parent = parentOf(tag);
    children.set(parent, [...(children.get(parent) ?? []), tag]);
  }
  for (const list of children.values()) {
    list.sort((a, b) => compareNames(tagName(a.value), tagName(b.value)));
  }

  const checkedBelow = new Map<string, number>();
  for (const tag of tags) {
    if (checked.has(tag.id)) {
      for (let parent = tagParentPath(tag.value); parent; parent = tagParentPath(parent)) {
        checkedBelow.set(parent, (checkedBelow.get(parent) ?? 0) + 1);
      }
    }
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const isMatch = (tag: TagResponseDto) => terms.every((term) => tag.value.toLowerCase().includes(term));
  let shown: Set<string> | undefined;
  if (terms.length > 0) {
    shown = new Set();
    for (const tag of tags) {
      if (isMatch(tag)) {
        for (let path = tag.value; path; path = tagParentPath(path)) {
          shown.add(path);
        }
      }
    }
  }

  const rows: TagRow[] = [];
  const visit = (parent: string, depth: number) => {
    for (const tag of children.get(parent) ?? []) {
      if (shown && !shown.has(tag.value)) {
        continue;
      }
      const hasChildren = children.has(tag.value);
      const isOpen = hasChildren && (shown ? true : expanded.has(tag.id));
      rows.push({
        tag,
        name: parent === '' ? tag.value : tagName(tag.value),
        depth,
        hasChildren,
        isOpen,
        isMatch: shown ? isMatch(tag) : true,
        checkedBelow: checkedBelow.get(tag.value) ?? 0,
      });
      if (isOpen) {
        visit(tag.value, depth + 1);
      }
    }
  };
  visit('', 0);

  return rows;
};

/** The tag Enter picks while searching: the one whose path or name is the query, else the first match */
export const pickTagRow = (rows: TagRow[], query: string) => {
  const text = query.trim().toLowerCase();
  const matches = rows.filter((row) => row.isMatch);
  return (
    matches.find((row) => row.tag.value.toLowerCase() === text) ??
    matches.find((row) => tagName(row.tag.value).toLowerCase() === text) ??
    matches[0]
  );
};

/** Tags grouped under their parent path (top level tags first, without a parent), for a compact list of chips */
export const groupTagsByParent = (tags: TagResponseDto[]) => {
  const groups = new Map<string, TagResponseDto[]>();
  for (const tag of tags) {
    const parent = tagParentPath(tag.value);
    groups.set(parent, [...(groups.get(parent) ?? []), tag]);
  }

  return [...groups]
    .sort(([a], [b]) => compareNames(a, b))
    .map(([parent, list]) => ({
      parent,
      tags: [...list].sort((a, b) => compareNames(tagName(a.value), tagName(b.value))),
    }));
};

/** black or white, whichever reads better on the tag's color (#rgb or #rrggbb); undefined for anything else */
export const tagTextColor = (color: string | null | undefined) => {
  const hex = color?.match(/^#?([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if (!hex) {
    return;
  }
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
  const [red, green, blue] = [0, 2, 4].map((start) => {
    const channel = Number.parseInt(full.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  // the luminance where black and white text have the same contrast
  return luminance > 0.179 ? '#000000' : '#ffffff';
};
