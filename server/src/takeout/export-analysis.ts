import { pathKey } from 'src/takeout/path-key';
import { ext, splitPath } from 'src/takeout/paths';
import {
  AnalysisReason,
  ExportAnalysis,
  ExportAnalysisInput,
  ExportAnalysisPart,
  PathSample,
  SizeCheck,
  UnreadablePart,
} from 'src/takeout/types';

const GiB = 2 ** 30;
const MiB = 2 ** 20;
const SPLIT_CANDIDATES = [2, 4, 10, 50].map((n) => n * GiB);
const SAMPLE_LIMIT = 200;
/** provisional until the family export's real ratio is measured (single-pass design task L1) */
export const SIZE_RATIO_SHORT = 0.95;
export const SIZE_RATIO_LOW = 0.99;

function suffixOf(fileName: string): string {
  const m = /\.(zip|tgz|tar\.gz)$/i.exec(fileName);
  return m ? m[0] : '.tgz';
}

function expectedName(sibling: ExportAnalysisPart, partNumber: number): string {
  const num = String(partNumber).padStart(3, '0');
  const segment = sibling.segment === null ? '' : `${sibling.segment}-`;
  return `takeout-${sibling.timestamp}-${segment}${num}${suffixOf(sibling.fileName)}`;
}

function sample(paths: string[]): PathSample {
  return { count: paths.length, sample: paths.slice(0, SAMPLE_LIMIT) };
}

// Google shortens long names inside the archives while the index lists them in full. A supplemental-metadata JSON
// loses the end of its stem, like the 46-unit cut the normal matcher undoes ('x.png.supplemental-metadata.json' is
// stored as 'x.png.sup.json', 'x.png..json' or 'x.json'); a media file loses the end of its stem too ('Screenshot
// 13_07_11.583191compressed-crop-13_06_31.523562.jpeg' is stored as 'Screenshot 13_07_11.58319.jpeg'). The key of
// such a stored name: its directory, extension and stem (a JSON stem without the trailing dots the cut can leave).
function shortenedKey(dir: string, extension: string, stem: string): string {
  return [dir, extension, extension === '.json' ? stem.replace(/\.+$/, '') : stem].join('\u{0}');
}

/**
 * The index cross-check, by pathKey: the index paths no archive path matches, and the number of archive paths the
 * index does not list. An index path also counts as present when an unlisted archive path of the same directory is
 * a shortened copy of its name: same extension, a shorter name, and a stem that starts the stem of the index name.
 * Each archive path stands in for one index path only, the longest candidate first.
 */
export function crossCheckIndex(
  indexFiles: string[],
  archiveKeys: Set<string>,
): { missing: string[]; notInIndex: number } {
  const indexKeys = new Set<string>();
  const unmatched: Array<{ path: string; key: string }> = [];
  for (const path of indexFiles) {
    const key = pathKey(path);
    indexKeys.add(key);
    if (!archiveKeys.has(key)) {
      unmatched.push({ path, key });
    }
  }

  let notInIndex = 0;
  const unlisted = new Map<string, string[]>();
  const unlistedDirs = new Set<string>();
  for (const key of archiveKeys) {
    if (indexKeys.has(key)) {
      continue;
    }
    notInIndex++;
    const { dir, base } = splitPath(key);
    const extension = ext(base);
    if (extension === '' || extension === base) {
      continue;
    }
    const candidate = shortenedKey(dir, extension, base.slice(0, -extension.length));
    const names = unlisted.get(candidate) ?? [];
    names.push(base);
    unlisted.set(candidate, names);
    unlistedDirs.add(shortenedKey(dir, extension, ''));
  }

  const missing: string[] = [];
  for (const { path, key } of unmatched) {
    const { dir, base } = splitPath(key);
    const extension = ext(base);
    const stem = base.slice(0, base.length - extension.length);
    let found = false;
    const candidates = extension !== '' && unlistedDirs.has(shortenedKey(dir, extension, ''));
    for (let length = stem.length - 1; candidates && length > 0 && !found; length--) {
      const names = unlisted.get(shortenedKey(dir, extension, stem.slice(0, length)));
      const at = names?.findIndex((name) => name.length < base.length) ?? -1;
      if (names && at !== -1) {
        names.splice(at, 1);
        notInIndex--;
        found = true;
      }
    }
    if (!found) {
      missing.push(path);
    }
  }
  return { missing, notInIndex };
}

// Pre-run detection (single-pass design 11): cheap inputs only (names, sizes, index, zip listings), plus the
// post-read checks of the last run (lastRead). Rules 1, 2, 3 and 5 of spec 2.3 are unchanged.
export function analyzeExport(input: ExportAnalysisInput): ExportAnalysis {
  const media = input.parts.filter((p) => !p.isIndex);
  const reasons = new Set<AnalysisReason>();

  // 1. Split size.
  let maxPartSize = 0;
  for (const p of media) {
    maxPartSize = Math.max(maxPartSize, p.size);
  }
  const splitSize: number | null =
    maxPartSize <= 50 * GiB + 16 * MiB ? (SPLIT_CANDIDATES.find((c) => c >= maxPartSize - 16 * MiB) ?? null) : null;

  // Group by segment.
  const bySegment = new Map<number | null, ExportAnalysisPart[]>();
  for (const part of media) {
    const list = bySegment.get(part.segment) ?? [];
    list.push(part);
    bySegment.set(part.segment, list);
  }

  // 2. Numbering gaps.
  const missingParts: ExportAnalysis['missingParts'] = [];
  const smallParts: string[] = [];
  let lastPartMayBeMissing = false;

  for (const [segment, parts] of bySegment) {
    const byNumber = new Map(parts.map((p) => [p.partNumber, p]));
    const maxNumber = Math.max(...parts.map((p) => p.partNumber));
    for (let n = 1; n <= maxNumber; n++) {
      if (byNumber.has(n)) {
        continue;
      }
      let sibling = byNumber.get(n - 1);
      for (let k = n - 1; k >= 1 && !sibling; k--) {
        sibling = byNumber.get(k);
      }
      sibling ??= parts[0];
      missingParts.push({ segment, partNumber: n, expectedName: expectedName(sibling, n) });
      reasons.add('missing_part');
    }

    // 3. Small parts (informational).
    if (splitSize !== null) {
      for (const part of parts) {
        if (part.partNumber !== maxNumber && part.size < splitSize * 0.98) {
          smallParts.push(part.fileName);
        }
      }
      const highest = byNumber.get(maxNumber);
      if (highest && highest.size > splitSize + 16 * MiB) {
        smallParts.push(highest.fileName);
      }
      // 5. Last part uncertainty (without index).
      if (highest && highest.size >= 0.98 * splitSize) {
        lastPartMayBeMissing = true;
      }
    }
  }

  // 4. Disk presence, zip listings, stability.
  const corruptParts: string[] = [];
  let partMissingOnDisk = false;
  let unstable = false;
  for (const part of input.parts) {
    if (part.isMissing) {
      partMissingOnDisk = true;
      reasons.add('part_missing_on_disk');
    } else if (!part.isIndex && !part.stable) {
      unstable = true;
    }
  }
  for (const listing of input.corruptListings) {
    corruptParts.push(`${listing.fileName}: ${listing.error}`);
    reasons.add('corrupt_part');
  }
  if (unstable) {
    reasons.add('part_unstable');
  }

  // Unreadable parts: what the last run reported, restricted to parts that are still unreadable now (a part
  // replaced since then is read again at the next run), plus parts in the error state the run did not list.
  const lastRead = input.lastRead;
  const byName = new Map(input.parts.map((p) => [p.fileName, p]));
  const unreadableParts: UnreadablePart[] = [];
  const listed = new Set<string>();
  for (const unreadable of lastRead?.unreadableParts ?? []) {
    const part = byName.get(unreadable.fileName);
    if (part && (part.catalogStatus === 'error' || part.isMissing)) {
      unreadableParts.push(unreadable);
      listed.add(unreadable.fileName);
    }
  }
  for (const part of media) {
    if (part.catalogStatus === 'error' && !listed.has(part.fileName)) {
      unreadableParts.push({
        fileName: part.fileName,
        error: part.catalogError ?? 'unreadable',
        offset: null,
        size: part.size,
      });
    }
  }
  if (unreadableParts.length > 0) {
    reasons.add('part_unreadable');
  }

  // 6. Size check against the index total.
  const partsTotalBytes = media.reduce((sum, p) => sum + p.size, 0);
  let sizeCheck: SizeCheck = 'unknown';
  if (input.indexTotalBytes && input.indexTotalBytes > 0) {
    const ratio = partsTotalBytes / input.indexTotalBytes;
    if (ratio < SIZE_RATIO_SHORT) {
      sizeCheck = 'short';
      reasons.add('size_shortfall');
    } else {
      sizeCheck = ratio < SIZE_RATIO_LOW ? 'low' : 'ok';
    }
  }

  // 7. Index cross-check: the catalog of the last run when there is one, else the zip listings (before any read).
  let indexMissingFiles: PathSample = { count: 0, sample: [] };
  let notInIndex = 0;
  let indexChecked = false;
  let listingChecked = false;
  if (input.index && lastRead?.indexMissingFiles) {
    indexChecked = true;
    indexMissingFiles = lastRead.indexMissingFiles;
    notInIndex = lastRead.notInIndex;
  } else if (input.index && input.listingPaths) {
    indexChecked = true;
    listingChecked = true;
    const check = crossCheckIndex(input.index.files, input.listingPaths);
    indexMissingFiles = sample(check.missing);
    notInIndex = check.notInIndex;
  }
  if (indexMissingFiles.count > 0) {
    reasons.add('index_missing_files');
  }

  // 8. JSON/media cross-check (post-read only).
  const summary = lastRead?.catalogSummary ?? null;
  const jsonWithoutMedia = summary ? sample(summary.jsonWithoutMedia) : { count: 0, sample: [] };
  const mediaWithoutJson = summary ? sample(summary.mediaWithoutJson) : { count: 0, sample: [] };
  if (jsonWithoutMedia.count > 0) {
    reasons.add('orphan_json');
  }

  // 9. Result.
  const allZip = media.length > 0 && media.every((p) => p.kind === 'zip');
  const incomplete =
    missingParts.length > 0 ||
    partMissingOnDisk ||
    corruptParts.length > 0 ||
    sizeCheck === 'short' ||
    indexMissingFiles.count > 0 ||
    unreadableParts.length > 0;
  let completeness: ExportAnalysis['completeness'];
  if (incomplete) {
    completeness = 'incomplete';
  } else if (media.length === 0 || unstable) {
    completeness = 'uncertain';
  } else if (input.index) {
    const listingOk = !allZip || indexChecked;
    completeness = sizeCheck === 'ok' && listingOk ? 'complete' : 'uncertain';
  } else {
    completeness = lastPartMayBeMissing ? 'uncertain' : 'complete';
  }
  if (completeness === 'uncertain' && lastPartMayBeMissing && !input.index) {
    reasons.add('last_part_may_be_missing');
  }

  return {
    completeness,
    splitSize,
    missingParts,
    smallParts,
    corruptParts,
    lastPartMayBeMissing,
    indexMissingFiles,
    notInIndex,
    indexChecked,
    jsonWithoutMedia,
    mediaWithoutJson,
    catalogSummary: summary,
    indexTotalBytes: input.indexTotalBytes,
    partsTotalBytes,
    sizeCheck,
    listingChecked,
    lastReadAt: lastRead?.at ?? null,
    lastReadRunId: lastRead?.runId ?? null,
    unreadableParts,
    unreadableEntries: lastRead?.unreadableEntries ?? 0,
    reasons: [...reasons],
  };
}
