import { AnalysisReason, ExportAnalysis, ExportAnalysisInput, ExportAnalysisPart } from 'src/takeout/types';

const GiB = 2 ** 30;
const MiB = 2 ** 20;
const SPLIT_CANDIDATES = [2, 4, 10, 50].map((n) => n * GiB);
const SAMPLE_LIMIT = 200;

function suffixOf(fileName: string): string {
  const m = /\.(zip|tgz|tar\.gz)$/i.exec(fileName);
  return m ? m[0] : '.tgz';
}

function expectedName(sibling: ExportAnalysisPart, partNumber: number): string {
  const num = String(partNumber).padStart(3, '0');
  const segment = sibling.segment === null ? '' : `${sibling.segment}-`;
  return `takeout-${sibling.timestamp}-${segment}${num}${suffixOf(sibling.fileName)}`;
}

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

  // 4. Readability and disk presence.
  const corruptParts: string[] = [];
  let partMissingOnDisk = false;
  let notScanned = false;
  for (const part of input.parts) {
    if (part.scanStatus === 'error') {
      corruptParts.push(part.scanError ? `${part.fileName}: ${part.scanError}` : part.fileName);
      reasons.add('corrupt_part');
    } else if (part.scanStatus === 'missing') {
      partMissingOnDisk = true;
      reasons.add('part_missing_on_disk');
    } else if (part.scanStatus !== 'scanned') {
      notScanned = true;
    }
  }
  if (notScanned) {
    reasons.add('not_scanned');
  }

  // 6. Index cross-check.
  let indexMissingFiles = { count: 0, sample: [] as string[] };
  let notInIndex = 0;
  let indexChecked = false;
  if (input.index && input.catalogPaths) {
    indexChecked = true;
    const catalog = input.catalogPaths;
    const trimmed = new Set<string>();
    for (const p of catalog) {
      trimmed.add(p.split('/').map((s) => s.trimEnd()).join('/'));
    }
    const missing: string[] = [];
    for (const path of input.index.files) {
      const alt = path.split('/').map((s) => s.trimEnd()).join('/');
      if (!catalog.has(path) && !trimmed.has(alt)) {
        missing.push(path);
      }
    }
    indexMissingFiles = { count: missing.length, sample: missing.slice(0, SAMPLE_LIMIT) };
    if (missing.length > 0) {
      reasons.add('index_missing_files');
    }
    const indexSet = new Set(input.index.files);
    for (const p of catalog) {
      if (!indexSet.has(p)) {
        notInIndex++;
      }
    }
  } else if (input.previous) {
    indexChecked = input.previous.indexChecked;
    indexMissingFiles = input.previous.indexMissingFiles;
    notInIndex = input.previous.notInIndex;
    if (indexMissingFiles.count > 0) {
      reasons.add('index_missing_files');
    }
  }

  // 7. JSON/media cross-check.
  const summary = input.catalogSummary ?? input.previous?.catalogSummary ?? null;
  const jsonWithoutMedia = summary
    ? { count: summary.jsonWithoutMedia.length, sample: summary.jsonWithoutMedia.slice(0, SAMPLE_LIMIT) }
    : { count: 0, sample: [] as string[] };
  const mediaWithoutJson = summary
    ? { count: summary.mediaWithoutJson.length, sample: summary.mediaWithoutJson.slice(0, SAMPLE_LIMIT) }
    : { count: 0, sample: [] as string[] };
  if (jsonWithoutMedia.count > 0) {
    reasons.add('orphan_json');
  }

  // 8. Result.
  const incomplete = missingParts.length > 0 || corruptParts.length > 0 || indexMissingFiles.count > 0 || partMissingOnDisk;
  let completeness: ExportAnalysis['completeness'];
  if (incomplete) {
    completeness = 'incomplete';
  } else if (notScanned) {
    completeness = 'uncertain';
  } else if (indexChecked && indexMissingFiles.count === 0) {
    completeness = 'complete';
  } else if (!input.index && !lastPartMayBeMissing) {
    const threshold = Math.max(5, Math.floor((summary?.assetJsons ?? 0) * 0.001));
    completeness = jsonWithoutMedia.count <= threshold ? 'complete' : 'uncertain';
  } else {
    completeness = 'uncertain';
  }
  if (completeness === 'uncertain' && lastPartMayBeMissing) {
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
    reasons: [...reasons],
  };
}
