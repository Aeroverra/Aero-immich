// Pure helpers used by takeout-run.service.ts (per spec 5.1/5.2 file layout).
// The stateful asset creation lives in the run service, which owns the repository handles.

/** Assemble the ordered, de-duplicated, non-null asset ids of a stack (2.7 Stack). */
export function assembleStackIds(
  members: Array<{ assetId: string | null; smallerAssetId: string | null }>,
  linkAssetIds: Array<string | null>,
): string[] {
  const ids: string[] = [];
  for (const member of members) {
    if (member.assetId) {
      ids.push(member.assetId);
    }
    if (member.smallerAssetId) {
      ids.push(member.smallerAssetId);
    }
  }
  for (const id of linkAssetIds) {
    if (id) {
      ids.push(id);
    }
  }
  const seen = new Set<string>();
  return ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
}

/**
 * De-duplicate tags (0.5 item 4): keep first occurrence, drop exact duplicates and blank values. Values are kept
 * verbatim, as Go sends them: Google person names can end in a space and the baseline tags keep it.
 */
export function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    if (!tag.trim() || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

/** True when the Google metadata carries a usable GPS location (Go asMetadata rules). */
export function hasLocation(latitude: number, longitude: number): boolean {
  return (latitude !== 0 || longitude !== 0) && Number.isFinite(latitude) && Number.isFinite(longitude);
}
