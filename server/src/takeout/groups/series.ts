import { isRawExt } from 'src/takeout/media-types';
import { EditedPairTest, Emission, GroupItem, newGroup } from 'src/takeout/groups/group';
import { GroupKind } from 'src/takeout/types';

const THRESHOLD_MS = 1000;

function captureDateOf(item: GroupItem): number | null {
  return item.captureDate ?? item.fileDate;
}

export function isVideoPair(item: GroupItem): boolean {
  return item.type === 'video' && (item.kind === 'videoBoost' || item.kind === 'nightSightVideo');
}

function sendVideoPair<T extends GroupItem>(members: T[], out: Array<Emission<T>>) {
  if (members.length !== 2 || members[0].kind !== members[1].kind || members[0].isCover === members[1].isCover) {
    for (const single of members) {
      out.push({ single });
    }
    return;
  }
  out.push({ group: newGroup('videoBoost', members, members[0].isCover ? 1 : 0) });
}

function sendGroup<T extends GroupItem>(members: T[], out: Array<Emission<T>>, isEditedPair?: EditedPairTest<T>) {
  if (members.length < 2) {
    for (const single of members) {
      out.push({ single });
    }
    return;
  }
  if (isVideoPair(members[0])) {
    sendVideoPair(members, out);
    return;
  }

  let kind: GroupKind = 'other';
  let gotJPG = false;
  let gotRAW = false;
  let gotHEIC = false;
  let gotMP4 = false;
  let gotMOV = false;
  let cover = 0;
  for (const [i, item] of members.entries()) {
    gotMP4 ||= item.ext === '.mp4';
    gotMOV ||= item.ext === '.mov';
    gotJPG ||= item.ext === '.jpg';
    gotRAW ||= isRawExt(item.ext);
    gotHEIC ||= item.ext === '.heic' || item.ext === '.heif';
    if (kind === 'other' && item.kind === 'burst') {
      kind = 'burst';
    }
    if (item.isCover) {
      cover = i;
    }
  }

  // [DEV 4] an edited copy with its original is always stacked as "other", never classified or filtered
  if (isEditedPair?.(members)) {
    out.push({ group: newGroup('other', members, cover) });
    return;
  }

  if (members.length === 2 && kind === 'other') {
    if (gotJPG && gotRAW && !gotHEIC) {
      kind = 'rawJpg';
    } else if (gotJPG && !gotRAW && gotHEIC) {
      kind = 'heicJpg';
    } else if ((gotMP4 || gotMOV) && (gotJPG || gotHEIC)) {
      for (const single of members) {
        out.push({ single });
      }
      return;
    }
  }
  out.push({ group: newGroup(kind, members, cover) });
}

// Go series.Group: the input is sorted by radical, then capture date.
export function groupSeries<T extends GroupItem>(items: Iterable<T>, isEditedPair?: EditedPairTest<T>): Array<Emission<T>> {
  const out: Array<Emission<T>> = [];
  let currentRadical = '';
  let currentCaptureDate: number | null = null;
  let currentVideoPair = false;
  let current: T[] = [];

  for (const item of items) {
    const cd = captureDateOf(item);
    const videoPair = isVideoPair(item);
    const tooFar = cd === null || currentCaptureDate === null || Math.abs(cd - currentCaptureDate) > THRESHOLD_MS;
    if (
      item.radical !== currentRadical ||
      videoPair !== currentVideoPair ||
      (!videoPair && (item.type !== 'image' || tooFar))
    ) {
      if (current.length > 0) {
        sendGroup(current, out, isEditedPair);
        current = [];
      }
      currentRadical = item.radical;
      currentCaptureDate = cd;
      currentVideoPair = videoPair;
    }
    current.push(item);
  }
  if (current.length > 0) {
    sendGroup(current, out, isEditedPair);
  }
  return out;
}
