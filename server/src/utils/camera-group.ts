/**
 * Files a camera saves from one shot, recognized by their file names:
 * - Pixel Video Boost and Night Sight videos: `PXL_20250929_175225242.VB-01.COVER.mp4` is the quick copy the phone
 *   keeps, `PXL_20250929_175225242.VB-02.MAIN.mp4` the processed one, which goes on top
 * - Pixel photo sets (long exposure, portrait, RAW, ...): `PXL_20240411_181110948.LONG_EXPOSURE-01.COVER.jpg` goes on
 *   top of `PXL_20240411_181110948.LONG_EXPOSURE-02.ORIGINAL.jpg`
 * - bursts: `00000IMG_00000_BURST20190530194629_COVER.jpg` goes on top of the other frames of `BURST20190530194629`
 *
 * Saved and edited copies such as `~2`, `(1)` and `-edited` do not match, so they stay separate items.
 */
export enum CameraGroupKind {
  VideoPair = 'videoPair',
  PhotoSet = 'photoSet',
  Burst = 'burst',
}

export interface CameraGroupFile {
  /** the same for every file of the shot */
  key: string;
  kind: CameraGroupKind;
  /** a `LIKE` pattern on the original file name that finds every file of the shot (and possibly others) */
  pattern: string;
  /** whether this file goes on top of the stack */
  isPrimary: boolean;
  /** the file's number within the shot, used to order burst frames */
  index: number;
}

const VIDEO_PAIR = /^(PXL_\d{8}_\d{9})\.(VB|NS)-(\d{2})\.(COVER|MAIN)\.[a-z\d]+$/i;
const PHOTO_SET = /^(PXL_\d{8}_\d{9})\.[a-z_]+-(\d{2})\.(?:[a-z]+\.)*?(COVER|ORIGINAL|MAIN)\.[a-z\d]+$/i;
const BURST = /^(\d+)\D+_\d+_(BURST\d+)(_COVER(?:_TOP)?)?\.[a-z\d]+$/i;

export const getCameraGroupFile = (originalFileName: string): CameraGroupFile | null => {
  const videoPair = VIDEO_PAIR.exec(originalFileName);
  if (videoPair) {
    const [, radical, kind, index, part] = videoPair;
    return {
      key: `${radical}.${kind.toUpperCase()}`,
      kind: CameraGroupKind.VideoPair,
      pattern: `${radical}.${kind}-%`,
      isPrimary: part.toUpperCase() === 'MAIN',
      index: Number(index),
    };
  }

  const photoSet = PHOTO_SET.exec(originalFileName);
  if (photoSet) {
    const [, radical, index, part] = photoSet;
    return {
      key: radical,
      kind: CameraGroupKind.PhotoSet,
      pattern: `${radical}.%`,
      isPrimary: part.toUpperCase() === 'COVER',
      index: Number(index),
    };
  }

  const burst = BURST.exec(originalFileName);
  if (burst) {
    const [, index, id, suffix] = burst;
    return {
      key: id.toUpperCase(),
      kind: CameraGroupKind.Burst,
      pattern: `%${id}%`,
      isPrimary: !!suffix,
      index: Number(index),
    };
  }

  return null;
};

export interface CameraGroupMember {
  id: string;
  originalFileName: string;
  file: CameraGroupFile;
}

/**
 * The files of one shot in stack order (the file on top first), or null when the names do not describe one shot
 * without doubt: a pair needs exactly one COVER and one MAIN video, a photo set exactly one COVER, and no two files
 * may share a name (duplicates of the same file).
 */
export const orderCameraGroup = <T extends CameraGroupMember>(
  kind: CameraGroupKind,
  members: T[],
  isVideo: (member: T) => boolean,
): T[] | null => {
  if (members.length < 2) {
    return null;
  }

  const names = new Set(members.map(({ originalFileName }) => originalFileName.toUpperCase()));
  if (names.size !== members.length) {
    return null;
  }

  const primaries = members.filter(({ file }) => file.isPrimary);
  switch (kind) {
    case CameraGroupKind.VideoPair: {
      if (members.length !== 2 || primaries.length !== 1 || members.some((member) => !isVideo(member))) {
        return null;
      }
      break;
    }

    case CameraGroupKind.PhotoSet: {
      if (primaries.length !== 1 || members.some((member) => isVideo(member))) {
        return null;
      }
      break;
    }

    case CameraGroupKind.Burst: {
      if (primaries.length > 1 || members.some((member) => isVideo(member))) {
        return null;
      }
      break;
    }
  }

  return members.toSorted((a, b) => {
    if (a.file.isPrimary !== b.file.isPrimary) {
      return a.file.isPrimary ? -1 : 1;
    }
    return a.file.index - b.file.index || a.originalFileName.localeCompare(b.originalFileName);
  });
};

/** whether a tag value matches one of the patterns, where `*` matches anything and the rest is compared as is */
export const matchesTagPattern = (value: string, patterns: string[]) =>
  patterns.some((pattern) => {
    const trimmed = pattern.trim();
    if (!trimmed) {
      return false;
    }
    const escaped = trimmed.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`).replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`, 'i').test(value);
  });

/**
 * The tag changes that give every file of a shot the same tags: a tag on one file is added to the others, except tags
 * that stay on one file (`keep`, such as where the file came from), and a `review` tag stays only when every file has
 * it, so one reviewed file marks the whole shot as reviewed.
 */
export const getCameraGroupTagChanges = (
  members: Array<{ assetId: string; tags: Array<{ id: string; value: string }> }>,
  { keep, review }: { keep: string[]; review: string[] },
) => {
  const add: Array<{ assetId: string; tagId: string }> = [];
  const remove: Array<{ assetId: string; tagId: string }> = [];

  const tags = new Map<string, { id: string; value: string; assetIds: Set<string> }>();
  for (const { assetId, tags: memberTags } of members) {
    for (const tag of memberTags) {
      const entry = tags.get(tag.id) ?? { ...tag, assetIds: new Set<string>() };
      entry.assetIds.add(assetId);
      tags.set(tag.id, entry);
    }
  }

  for (const tag of tags.values()) {
    if (tag.assetIds.size === members.length) {
      continue;
    }

    if (matchesTagPattern(tag.value, review)) {
      for (const assetId of tag.assetIds) {
        remove.push({ assetId, tagId: tag.id });
      }
      continue;
    }

    if (matchesTagPattern(tag.value, keep)) {
      continue;
    }

    for (const { assetId } of members) {
      if (!tag.assetIds.has(assetId)) {
        add.push({ assetId, tagId: tag.id });
      }
    }
  }

  return { add, remove };
};
