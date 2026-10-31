import { Group, GroupItem, removeMember } from 'src/takeout/groups/group';
import { isRawExt } from 'src/takeout/media-types';
import { BurstMode, HeicJpgMode, RawJpgMode, TakeoutSettings, VideoBoostMode } from 'src/takeout/types';

// Ports of immich-go internal/filters. Cover indexes are positions, as in Go (RemoveAsset does not move them).
export type GroupFilter = <T extends GroupItem>(group: Group<T>) => Group<T>;

const isJpeg = (item: GroupItem) => item.ext === '.jpg' || item.ext === '.jpeg';
const isHeic = (item: GroupItem) => item.ext === '.heic';

function keepOnly<T extends GroupItem>(group: Group<T>, keep: (item: T) => boolean, reason: string): Group<T> {
  const removed = group.members.filter((item) => !keep(item));
  if (removed.length < group.members.length) {
    for (const item of removed) {
      removeMember(group, item, reason);
    }
  }
  if (group.members.length < 2) {
    group.kind = 'none';
  }
  return group;
}

function setCover<T extends GroupItem>(group: Group<T>, test: (item: T) => boolean): Group<T> {
  const i = group.members.findIndex((item) => test(item));
  if (i !== -1) {
    group.coverIndex = i;
  }
  return group;
}

export function burstFilter(mode: BurstMode): GroupFilter {
  return <T extends GroupItem>(group: Group<T>) => {
    if (group.kind !== 'burst') {
      return group;
    }
    switch (mode) {
      case 'NoStack': {
        group.kind = 'none';
        return group;
      }
      case 'Stack': {
        return group;
      }
      case 'StackKeepRaw': {
        return keepOnly(group, (item) => isRawExt(item.ext), 'Keep only RAW files in burst');
      }
      case 'StackKeepJPEG': {
        return keepOnly(group, isJpeg, 'Keep only JPEG files in burst');
      }
    }
  };
}

export function rawJpgFilter(mode: RawJpgMode): GroupFilter {
  return <T extends GroupItem>(group: Group<T>) => {
    if (group.kind !== 'rawJpg') {
      return group;
    }
    switch (mode) {
      case 'NoStack': {
        group.kind = 'none';
        return group;
      }
      case 'KeepRaw': {
        return keepOnly(group, (item) => isRawExt(item.ext), 'Keep only RAW files in RAW/JPEG group');
      }
      case 'KeepJPG': {
        return keepOnly(group, isJpeg, 'Keep only JPEG files in RAW/JPEG group');
      }
      case 'StackCoverRaw': {
        return setCover(group, (item) => isRawExt(item.ext));
      }
      case 'StackCoverJPG': {
        return setCover(group, isJpeg);
      }
    }
  };
}

export function heicJpgFilter(mode: HeicJpgMode): GroupFilter {
  return <T extends GroupItem>(group: Group<T>) => {
    if (group.kind !== 'heicJpg') {
      return group;
    }
    switch (mode) {
      case 'NoStack': {
        group.kind = 'none';
        return group;
      }
      case 'KeepHeic': {
        return keepOnly(group, isHeic, 'Keep only HEIC files in HEIC/JPEG group');
      }
      case 'KeepJPG': {
        // Go's reason text for this filter says HEIC too
        return keepOnly(group, isJpeg, 'Keep only HEIC files in HEIC/JPEG group');
      }
      case 'StackCoverHeic': {
        return setCover(group, isHeic);
      }
      case 'StackCoverJPG': {
        return setCover(group, isJpeg);
      }
    }
  };
}

export function videoBoostFilter(mode: VideoBoostMode): GroupFilter {
  return <T extends GroupItem>(group: Group<T>) => {
    if (group.kind !== 'videoBoost') {
      return group;
    }
    switch (mode) {
      case 'NoStack': {
        group.kind = 'none';
        return group;
      }
      case 'Stack': {
        return setCover(group, (item) => !item.isCover);
      }
      case 'KeepMain': {
        keepOnly(
          group,
          (item) => !item.isCover,
          'Keep only the processed video of a Pixel Video Boost / Night Sight video',
        );
        if (group.members.length < 2) {
          group.coverIndex = 0;
        }
        return group;
      }
    }
  };
}

// Go filters.ApplyFilters in the upload order: burst, raw/jpeg, heic/jpeg, video boost; never for "none" groups
export function applyFilters<T extends GroupItem>(group: Group<T>, settings: TakeoutSettings): Group<T> {
  if (group.kind === 'none') {
    return group;
  }
  let g = group;
  for (const filter of [
    burstFilter(settings.burst),
    rawJpgFilter(settings.rawJpg),
    heicJpgFilter(settings.heicJpg),
    videoBoostFilter(settings.videoBoost),
  ]) {
    g = filter(g);
  }
  return g;
}

function parseMode<T extends string>(value: string, values: readonly T[], name: string): T {
  const lower = value.toLowerCase();
  if (lower === '') {
    return values[0];
  }
  const found = values.find((v) => v.toLowerCase() === lower);
  if (!found) {
    throw new Error(`invalid value "${value}" for ${name}`);
  }
  return found;
}

export const RAW_JPG_MODES = ['NoStack', 'KeepRaw', 'KeepJPG', 'StackCoverRaw', 'StackCoverJPG'] as const;
export const BURST_MODES = ['NoStack', 'Stack', 'StackKeepRaw', 'StackKeepJPEG'] as const;
export const HEIC_JPG_MODES = ['NoStack', 'KeepHeic', 'KeepJPG', 'StackCoverHeic', 'StackCoverJPG'] as const;
export const VIDEO_BOOST_MODES = ['NoStack', 'Stack', 'KeepMain'] as const;

export const parseRawJpgMode = (value: string): RawJpgMode => parseMode(value, RAW_JPG_MODES, 'RawJPGFlag');
export const parseBurstMode = (value: string): BurstMode => parseMode(value, BURST_MODES, 'BurstFlag');
export const parseHeicJpgMode = (value: string): HeicJpgMode => parseMode(value, HEIC_JPG_MODES, 'HeicJpgFlag');
export const parseVideoBoostMode = (value: string): VideoBoostMode =>
  parseMode(value, VIDEO_BOOST_MODES, 'VideoBoostFlag');
