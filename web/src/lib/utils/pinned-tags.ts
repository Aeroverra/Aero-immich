import type { TagResponseDto } from '@immich/sdk';

/** Pins the tag, or unpins it when it is pinned already; the newest pin goes last */
export const togglePinnedTag = (pinned: string[], tagId: string) =>
  pinned.includes(tagId) ? pinned.filter((id) => id !== tagId) : [...pinned, tagId];

/** The pinned tags that still exist, in pin order, without the ids of deleted tags */
export const getPinnedTags = (pinned: string[], tags: TagResponseDto[]) => {
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  return pinned.map((id) => byId.get(id)).filter((tag) => tag !== undefined);
};

/** How many of the selected assets carry a tag: all, some or none of them */
export type TagCoverage = 'all' | 'some' | 'none';

export const getTagCoverage = (count: number, total: number): TagCoverage => {
  if (total > 0 && count >= total) {
    return 'all';
  }
  return count > 0 ? 'some' : 'none';
};

/**
 * The next staged change of a pinned tag when its chip is clicked: true adds the tag to every selected asset, false
 * takes it off every one of them, undefined leaves the assets as they are. A tag all assets carry can only be taken
 * off and one none of them carry only added, so a second click undoes the first; a tag only some carry goes from
 * add to all, to take off all, back to unchanged.
 */
export const nextTagChange = (change: boolean | undefined, coverage: TagCoverage): boolean | undefined => {
  switch (coverage) {
    case 'all': {
      return change === undefined ? false : undefined;
    }
    case 'none': {
      return change === undefined ? true : undefined;
    }
    default: {
      if (change === undefined) {
        return true;
      }
      return change ? false : undefined;
    }
  }
};
