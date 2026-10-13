import { originalNameOfEdited } from 'src/takeout/edited';
import { isMediaExt, mediaTypeOfExt } from 'src/takeout/media-types';
import { dropLastRune, ext, firstRunes, nfc, runeCount, trimExt, utf8Length } from 'src/takeout/paths';
import { MatcherName } from 'src/takeout/types';

// Google truncates supplemental-metadata JSON names at this length (UTF-16 units for [DEV 1] cutShort).
export const CUT_LENGTH = 46;

// Go getFileIndex: strips a trailing "(k)" numeric index, returning the stripped name and the index string.
export function getFileIndex(name: string): { name: string; index: string } {
  const p1 = name.lastIndexOf('(');
  if (p1 !== -1) {
    const p2 = name.lastIndexOf(')');
    if (p2 !== -1 && p2 > p1) {
      const index = name.slice(p1 + 1, p2);
      if (/^[+-]?\d+$/.test(index)) {
        return { name: name.slice(0, p1) + name.slice(p2 + 1), index };
      }
    }
  }
  return { name, index: '' };
}

// Go matchFastTrack: the file name equals the JSON name with its extension removed.
export function matchFastTrack(jsonName: string, fileName: string): boolean {
  return trimExt(jsonName) === fileName;
}

// Go matchNormal (byte-length truncation handling kept as in Go).
export function matchNormal(jsonNameRaw: string, fileNameRaw: string): boolean {
  const file = getFileIndex(fileNameRaw);
  const json = getFileIndex(jsonNameRaw);
  if (file.index !== json.index) {
    return false;
  }
  let jsonName = json.name;
  let fileName = file.name;

  const p2 = jsonName.lastIndexOf('.');
  if (p2 > 1) {
    const p1 = jsonName.slice(0, p2).lastIndexOf('.');
    if (p1 > 1 && 'supplemental-metadata'.startsWith(jsonName.slice(p1 + 1, p2))) {
      jsonName = jsonName.slice(0, p1) + jsonName.slice(p2);
    }
  }

  jsonName = trimExt(jsonName);
  if (jsonName === fileName) {
    return true;
  }

  if (utf8Length(fileName) > 46) {
    if (runeCount(fileName) > 46) {
      fileName = firstRunes(fileName, 46);
    } else {
      fileName = trimExt(fileName);
      fileName = dropLastRune(fileName);
    }
    if (fileName === jsonName) {
      return true;
    }
  }
  return false;
}

// Go matchForgottenDuplicates.
export function matchForgottenDuplicates(jsonNameRaw: string, fileNameRaw: string): boolean {
  const jsonName = trimExt(jsonNameRaw);
  const fileName = trimExt(fileNameRaw);
  if (fileName.startsWith(jsonName)) {
    return runeCount(fileName) - runeCount(jsonName) < 10;
  }
  return false;
}

// [DEV 1] cutShort: the JSON stem (index removed) is at Google's truncation length.
function cutShort(jsonName: string): boolean {
  const n = getFileIndex(trimExt(jsonName)).name;
  return n.length >= CUT_LENGTH;
}

// [DEV 1] baseOf: the JSON name without ".json" and without a truncated "supplemental-metadata" trailer.
function baseOf(jsonName: string): string {
  let b = trimExt(jsonName);
  const p1 = b.lastIndexOf('.');
  if (p1 > 1 && 'supplemental-metadata'.startsWith(b.slice(p1 + 1))) {
    b = b.slice(0, p1);
  }
  return b;
}

// [DEV 1] plainMatch: rules 1 and 2 (no edited suffix).
function plainMatch(jsonName: string, fileName: string): boolean {
  const b = baseOf(jsonName);
  const fe = ext(fileName);
  if (!isMediaExt(fe)) {
    return false;
  }
  const fs = fileName.slice(0, fileName.length - fe.length);
  const e = ext(b);
  const stem = e !== '' && isMediaExt(e) ? b.slice(0, b.length - e.length) : b;
  if (fs === stem) {
    return true;
  }
  if (
    cutShort(jsonName) &&
    fileName.startsWith(b) &&
    fileName.length > b.length &&
    fe.endsWith(fileName.slice(b.length))
  ) {
    return true;
  }
  return false;
}

// [DEV 1] Edited-name matcher (replaces Go matchEditedName; 4th matcher, skips indexed files).
export function matchEdited(jsonNameRaw: string, fileNameRaw: string): boolean {
  const jsonName = nfc(jsonNameRaw);
  const fileName = nfc(fileNameRaw);
  if (getFileIndex(fileName).index !== '') {
    return false;
  }
  if (plainMatch(jsonName, fileName)) {
    return true;
  }
  const orig = originalNameOfEdited(fileName);
  if (orig !== null && (matchFastTrack(jsonName, orig) || matchNormal(jsonName, orig) || plainMatch(jsonName, orig))) {
    return true;
  }
  // rule 4: motion photo video "MVIMG_x.jpg.json" <-> "MVIMG_x_1.MP4"
  const b = baseOf(jsonName);
  const fe = ext(fileName);
  const fs = fileName.slice(0, fileName.length - fe.length);
  const e = ext(b);
  const stem = e !== '' && isMediaExt(e) ? b.slice(0, b.length - e.length) : b;
  if (fs.startsWith(stem)) {
    const fsAfterStem = fs.slice(stem.length);
    if (/^_\d+$/.test(fsAfterStem) && mediaTypeOfExt(fe) === 'video') {
      return true;
    }
  }
  return false;
}

export interface Matcher {
  name: MatcherName;
  fn: (jsonName: string, fileName: string) => boolean;
}

// solvePuzzle order (matcher-major).
export const MATCHERS: Matcher[] = [
  { name: 'fastTrack', fn: matchFastTrack },
  { name: 'normal', fn: matchNormal },
  { name: 'forgottenDuplicates', fn: matchForgottenDuplicates },
  { name: 'edited', fn: matchEdited },
];
