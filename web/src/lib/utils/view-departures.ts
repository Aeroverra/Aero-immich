import type { CustomViewResponseDto, TagResponseDto } from '@immich/sdk';

type ViewRule = Pick<CustomViewResponseDto, 'includeAll' | 'includeUntagged' | 'includeTagIds' | 'excludeTagIds'>;

/**
 * Whether tagging assets takes them out of the view the session sees: `all` when every one of them leaves, `none`
 * when none can, `unknown` when it depends on the other tags of each asset, which the client does not know.
 *
 * A view shows the assets that are included (every asset, the untagged ones, or the ones carrying an include tag or
 * one of its descendants) and not excluded (carrying an exclude tag or one of its descendants; exclude wins).
 */
export const getViewDeparture = (
  view: ViewRule | null | undefined,
  tags: TagResponseDto[],
  { addIds, removeIds }: { addIds: string[]; removeIds: string[] },
): 'all' | 'none' | 'unknown' => {
  if (!view) {
    return 'none';
  }

  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  // a tag matches a rule tag when it is that tag or one of its descendants
  const matches = (tagId: string, ruleIds: string[]) => {
    if (ruleIds.includes(tagId)) {
      return true;
    }
    const value = byId.get(tagId)?.value;
    if (!value) {
      return false;
    }
    return ruleIds.some((ruleId) => {
      const ruleValue = byId.get(ruleId)?.value;
      return !!ruleValue && value.startsWith(`${ruleValue}/`);
    });
  };

  if (addIds.some((tagId) => matches(tagId, view.excludeTagIds))) {
    return 'all';
  }

  if (view.includeAll) {
    return 'none';
  }

  // an asset may carry another include tag, or have been untagged before
  if (removeIds.some((tagId) => matches(tagId, view.includeTagIds))) {
    return 'unknown';
  }
  if (view.includeUntagged && addIds.some((tagId) => !matches(tagId, view.includeTagIds))) {
    return 'unknown';
  }

  return 'none';
};
