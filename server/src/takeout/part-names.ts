import { compareBytes } from 'src/takeout/byte-order';
import { ArchiveKind, DetectedExport, DetectedPart, FolderFile, PartName } from 'src/takeout/types';

const PART_RE = /^takeout-(\d{8}T\d{6}Z)-(?:(\d+)-)?(\d{3})\.(zip|tgz|tar\.gz)$/i;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_SECONDS_MS = 5 * 1000;

// Parses 'YYYYMMDDTHHMMSSZ' as a UTC instant.
function timestampToDate(timestamp: string): Date {
  const iso = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(9, 11)}:${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}Z`;
  return new Date(iso);
}

export function parsePartName(fileName: string): PartName | null {
  const m = PART_RE.exec(fileName);
  if (!m) {
    return null;
  }
  const kind: ArchiveKind = m[4].toLowerCase() === 'zip' ? 'zip' : 'tgz';
  return {
    fileName,
    timestamp: m[1],
    exportedAt: timestampToDate(m[1]),
    segment: m[2] === undefined ? null : Number(m[2]),
    partNumber: Number(m[3]),
    kind,
  };
}

// Go takeout tag rule: the part name with the extension and a trailing '-NNN' stripped.
export function takeoutTagName(partFileName: string): string {
  const withoutExt = partFileName.replace(/\.(zip|tgz|tar\.gz)$/i, '');
  return withoutExt.replace(/-\d{3}$/, '');
}

function comparePartOrder(a: PartName, b: PartName): number {
  const sa = a.segment ?? -1;
  const sb = b.segment ?? -1;
  if (sa !== sb) {
    return sa - sb;
  }
  return a.partNumber - b.partNumber;
}

interface Chain {
  kind: ArchiveKind;
  parts: DetectedPart[];
  firstTimestamp: number;
  lastTimestamp: number;
}

// Groups detected part files into exports (chains), following spec section 2.2 step 3.
export function groupExports(
  files: FolderFile[],
  knownIndexFiles: Set<string>,
  rejectedIndexFiles: Set<string>,
): { exports: DetectedExport[]; orphanIndexes: DetectedPart[]; otherFiles: FolderFile[] } {
  const otherFiles: FolderFile[] = [];
  const parsed: DetectedPart[] = [];
  for (const file of files) {
    const name = parsePartName(file.fileName);
    if (!name) {
      otherFiles.push(file);
      continue;
    }
    parsed.push({ ...name, size: file.size, mtime: file.mtime, ctime: file.ctime, isIndex: false, indexConfirmed: false });
  }

  const isIndex = (part: DetectedPart): boolean => {
    if (knownIndexFiles.has(part.fileName)) {
      return true;
    }
    if (rejectedIndexFiles.has(part.fileName)) {
      return false;
    }
    if (part.segment === null && part.partNumber === 1) {
      const sibling = parsed.some((other) => other !== part && other.timestamp === part.timestamp);
      return !sibling;
    }
    return false;
  };

  const indexes: DetectedPart[] = [];
  const media: DetectedPart[] = [];
  for (const part of parsed) {
    if (isIndex(part)) {
      part.isIndex = true;
      part.indexConfirmed = knownIndexFiles.has(part.fileName);
      indexes.push(part);
    } else {
      media.push(part);
    }
  }

  media.sort((a, b) => {
    if (a.exportedAt.getTime() !== b.exportedAt.getTime()) {
      return a.exportedAt.getTime() - b.exportedAt.getTime();
    }
    return comparePartOrder(a, b);
  });

  const chains: Chain[] = [];
  for (const part of media) {
    const time = part.exportedAt.getTime();
    let best: Chain | null = null;
    for (const chain of chains) {
      if (chain.kind !== part.kind) {
        continue;
      }
      if (chain.parts.some((x) => x.segment === part.segment && x.partNumber === part.partNumber)) {
        continue;
      }
      let maxOfSegment = 0;
      for (const x of chain.parts) {
        if (x.segment === part.segment) {
          maxOfSegment = Math.max(maxOfSegment, x.partNumber);
        }
      }
      if (maxOfSegment >= part.partNumber) {
        continue;
      }
      if (time - chain.lastTimestamp > SEVEN_DAYS_MS) {
        continue;
      }
      if (best === null || chain.lastTimestamp > best.lastTimestamp) {
        best = chain;
      }
    }
    if (best) {
      best.parts.push(part);
      best.lastTimestamp = Math.max(best.lastTimestamp, time);
    } else {
      chains.push({ kind: part.kind, parts: [part], firstTimestamp: time, lastTimestamp: time });
    }
  }

  const chainIndex = new Map<Chain, DetectedPart | null>();
  const orphanIndexes: DetectedPart[] = [];
  for (const index of indexes) {
    const time = index.exportedAt.getTime();
    let target: Chain | null = null;
    for (const chain of chains) {
      if (chainIndex.has(chain)) {
        continue;
      }
      if (time >= chain.firstTimestamp - FIVE_SECONDS_MS && time <= chain.lastTimestamp + SEVEN_DAYS_MS && (target === null || Math.abs(time - chain.firstTimestamp) < Math.abs(time - target.firstTimestamp))) {
          target = chain;
        }
    }
    if (target) {
      chainIndex.set(target, index);
    } else {
      orphanIndexes.push(index);
    }
  }

  const exports: DetectedExport[] = chains.map((chain) => {
    const sorted = [...chain.parts].sort(comparePartOrder);
    const first = sorted[0];
    const exportKey = first.segment === null ? first.timestamp : `${first.timestamp}-${first.segment}`;
    const index = chainIndex.get(chain);
    return { exportKey, exportedAt: first.exportedAt, parts: index ? [...sorted, index] : sorted };
  });
  exports.sort((a, b) => a.exportedAt.getTime() - b.exportedAt.getTime() || compareBytes(a.exportKey, b.exportKey));

  return { exports, orphanIndexes, otherFiles };
}
