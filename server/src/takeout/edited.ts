import { isDecodable } from 'src/takeout/media-types';
import { base, nfc, splitPath } from 'src/takeout/paths';

// Go editedrotation.go:20 plus the "i" flag, applied to NFC names. The one shared definition of an edited copy.
export const EDITED_NAME_RE =
  /^(.+)-(edited|modifié|bearbeitet|editado|modificato|bewerkt|redigert|redigerad|muokattu|edytowane)(\(\d+\))?(\.[^.]+)$/iu;

// Immich refuses edits on motion photos (Go editedrotation.go:25)
export const MOTION_NAME_RE = /(^MVIMG_|\.MP(~\d+)?\.)/i;

export function originalNameOfEdited(name: string): string | null {
  const m = EDITED_NAME_RE.exec(nfc(name));
  if (!m) {
    return null;
  }
  return m[1] + (m[3] ?? '') + m[4];
}

export function isEditedCopy(name: string): boolean {
  return EDITED_NAME_RE.test(nfc(base(name)));
}

export function isMotionName(name: string): boolean {
  return MOTION_NAME_RE.test(name);
}

// Sampling set (2.4 step 3) and sample pruning rule (2.4 step 7): every decodable edited-named file, plus every
// decodable file named like the original of an edited-named file of the same directory. Exact paths are returned.
export function samplePairsToKeep(paths: string[]): Set<string> {
  const byDir = new Map<string, Map<string, string>>();
  for (const path of paths) {
    const { dir, base: name } = splitPath(path);
    const key = nfc(dir);
    let names = byDir.get(key);
    if (!names) {
      names = new Map();
      byDir.set(key, names);
    }
    const nfcName = nfc(name);
    if (!names.has(nfcName)) {
      names.set(nfcName, path);
    }
  }

  const keep = new Set<string>();
  for (const names of byDir.values()) {
    for (const [name, path] of names) {
      const original = originalNameOfEdited(name);
      if (original === null) {
        continue;
      }
      if (isDecodable(name)) {
        keep.add(path);
      }
      const originalPath = names.get(original);
      if (originalPath !== undefined && isDecodable(original)) {
        keep.add(originalPath);
      }
    }
  }
  return keep;
}
