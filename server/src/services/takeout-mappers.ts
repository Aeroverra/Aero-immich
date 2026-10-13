import {
  TakeoutAnalysisDto,
  TakeoutExportDto,
  TakeoutPartDto,
  TakeoutRunDto,
  TakeoutRunReadStatsDto,
  TakeoutSettingsDto,
  TakeoutUploadDto,
} from 'src/dtos/takeout.dto';
import {
  TakeoutArchiveKind,
  TakeoutCatalogStatus,
  TakeoutExportReadStatus,
  TakeoutPartReadStatus,
  TakeoutRunPartStatus,
  TakeoutRunStatus,
  TakeoutScanStatus,
  TakeoutSizeCheck,
} from 'src/enum';
import { CATALOG_VERSION, normalizeReadStats, pauseStateOf } from 'src/services/takeout-read';
import { ANALYSIS_REASONS, mergeSettings } from 'src/takeout';

// DTO mappers shared by the takeout services (single-pass design 13.1).

export const UPLOAD_CHUNK_SIZE = 32 * 1024 * 1024;
const STALE_UPLOAD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Row flags that are internal bookkeeping (quota accounting and the result counters of counters.ts), not
 * fallbacks the user needs to review: hidden from the per-file report and the CSV.
 */
const INTERNAL_FLAGS = new Set(['quotaCounted', 'albumAdded', 'tagged', 'metadataSaved', 'stacked']);
export const reportFallbacks = (fallbacks: string[] | null | undefined): string[] =>
  (fallbacks ?? []).filter((flag) => !INTERNAL_FLAGS.has(flag) && !flag.startsWith('albumCreated:'));

const iso = (value: Date | string | null | undefined): string | null =>
  value ? (value instanceof Date ? value.toISOString() : new Date(value).toISOString()) : null;

export function partReadStatus(part: {
  isMissing: boolean;
  catalogStatus: string;
  catalogVersion: number | null;
}): TakeoutPartReadStatus {
  if (part.isMissing) {
    return TakeoutPartReadStatus.Missing;
  }
  if (part.catalogVersion !== CATALOG_VERSION && part.catalogStatus !== TakeoutCatalogStatus.None) {
    return TakeoutPartReadStatus.NotRead;
  }
  switch (part.catalogStatus) {
    case TakeoutCatalogStatus.Complete: {
      return TakeoutPartReadStatus.Read;
    }
    case TakeoutCatalogStatus.Error: {
      return TakeoutPartReadStatus.Error;
    }
    case TakeoutCatalogStatus.Reading: {
      return TakeoutPartReadStatus.Reading;
    }
    case TakeoutCatalogStatus.Partial: {
      return TakeoutPartReadStatus.Partial;
    }
    default: {
      return TakeoutPartReadStatus.NotRead;
    }
  }
}

const SCAN_STATUS_OF_PART: Record<TakeoutPartReadStatus, TakeoutScanStatus> = {
  [TakeoutPartReadStatus.NotRead]: TakeoutScanStatus.Pending,
  [TakeoutPartReadStatus.Partial]: TakeoutScanStatus.Pending,
  [TakeoutPartReadStatus.Reading]: TakeoutScanStatus.Scanning,
  [TakeoutPartReadStatus.Read]: TakeoutScanStatus.Scanned,
  [TakeoutPartReadStatus.Error]: TakeoutScanStatus.Error,
  [TakeoutPartReadStatus.Missing]: TakeoutScanStatus.Missing,
};

export function mapPart(part: any): TakeoutPartDto {
  const readStatus = partReadStatus(part);
  const readError: string | null = part.catalogError ?? null;
  const bytesRead = Number(part.bytesRead ?? 0);
  return {
    id: part.id,
    fileName: part.fileName,
    segment: part.segment,
    partNumber: part.partNumber,
    kind: part.kind as TakeoutArchiveKind,
    isIndex: part.isIndex,
    size: Number(part.size),
    mtime: iso(part.mtime)!,
    readStatus,
    bytesRead,
    entryCount: readStatus === TakeoutPartReadStatus.Read ? (part.entryCount ?? null) : null,
    readError,
    readErrorOffset:
      part.catalogErrorOffset === null || part.catalogErrorOffset === undefined
        ? null
        : Number(part.catalogErrorOffset),
    lastReadRunId: part.lastReadRunId ?? null,
    scanStatus: SCAN_STATUS_OF_PART[readStatus],
    bytesScanned: bytesRead,
    scanError: readError,
  };
}

export function exportReadStatus(parts: any[]): { readStatus: TakeoutExportReadStatus; partsRead: number } {
  const media = parts.filter((p) => !p.isIndex);
  const present = media.filter((p) => !p.isMissing);
  const states = present.map((p) => partReadStatus(p));
  const partsRead = states.filter((s) => s === TakeoutPartReadStatus.Read).length;
  let readStatus: TakeoutExportReadStatus;
  if (states.includes(TakeoutPartReadStatus.Error)) {
    readStatus = TakeoutExportReadStatus.Error;
  } else if (present.length > 0 && partsRead === present.length) {
    readStatus = TakeoutExportReadStatus.Read;
  } else if (states.some((s) => s !== TakeoutPartReadStatus.NotRead)) {
    readStatus = TakeoutExportReadStatus.Partial;
  } else {
    readStatus = TakeoutExportReadStatus.NotRead;
  }
  return { readStatus, partsRead };
}

const SCAN_STATUS_OF_EXPORT: Record<TakeoutExportReadStatus, TakeoutScanStatus> = {
  [TakeoutExportReadStatus.NotRead]: TakeoutScanStatus.Pending,
  [TakeoutExportReadStatus.Partial]: TakeoutScanStatus.Scanning,
  [TakeoutExportReadStatus.Read]: TakeoutScanStatus.Scanned,
  [TakeoutExportReadStatus.Error]: TakeoutScanStatus.Error,
};

/**
 * The parts an export should have: the parts found plus the gaps of the last analysis that are still gaps. The index
 * lists files, not parts, so its file count is no part count.
 */
export function expectedPartCount(exp: { analysis?: unknown }, parts: any[]): number {
  const media = parts.filter((p) => !p.isIndex);
  const gaps: Array<{ segment: number | null; partNumber: number }> = (exp.analysis as any)?.missingParts ?? [];
  const open = gaps.filter((gap) => media.every((p) => p.segment !== gap.segment || p.partNumber !== gap.partNumber));
  return media.length + open.length;
}

export function mapExport(exp: any, parts: any[], lastRun: any): TakeoutExportDto {
  const mediaParts = parts.filter((p) => !p.isIndex);
  const { readStatus, partsRead } = exportReadStatus(parts);
  return {
    id: exp.id,
    exportKey: exp.exportKey,
    exportedAt: iso(exp.exportedAt)!,
    completeness: exp.completeness,
    readStatus,
    partsRead,
    scanStatus: SCAN_STATUS_OF_EXPORT[readStatus],
    partCount: mediaParts.length,
    expectedPartCount: expectedPartCount(exp, parts),
    totalSize: parts.reduce((sum, p) => sum + Number(p.size), 0),
    bytesScanned: parts.reduce((sum, p) => sum + Number(p.bytesRead ?? 0), 0),
    accountEmail: exp.accountEmail,
    indexFileCount: exp.indexFileCount,
    indexTotalSize: exp.indexTotalSize,
    archivesDeletedAt: iso(exp.archivesDeletedAt),
    lastRun: lastRun ? mapRun(lastRun) : null,
  };
}

export function mapReadStats(stored: unknown): TakeoutRunReadStatsDto {
  const stats = normalizeReadStats(stored);
  const parts = Object.values(stats.parts)
    .toSorted((a, b) => (a.segment ?? -1) - (b.segment ?? -1) || a.partNumber - b.partNumber)
    .map((ps) => ({
      partId: ps.partId,
      fileName: ps.fileName,
      size: ps.size,
      status: ps.status as TakeoutRunPartStatus,
      passes: ps.passes,
      bytesRead: ps.bytesRead,
      bytesSkipped: ps.bytesSkipped,
      position: ps.position,
      fetchBytesRead: ps.fetchBytesRead,
      entries: ps.entries,
      media: ps.media,
      entryErrors: ps.entryErrors,
      staged: ps.staged,
      stagedBytes: ps.stagedBytes,
      duplicates: ps.duplicates,
      deferred: ps.deferred,
      transportRetries: ps.transportRetries,
      error: ps.error,
      errorOffset: ps.errorOffset,
      startedAt: ps.startedAt,
      finishedAt: ps.finishedAt,
      pausedMs: Math.max(0, Math.round(ps.pausedMs)),
    }));
  return {
    readers: stats.readers,
    readahead: stats.readahead,
    crossDevice: stats.crossDevice,
    filesFound: stats.filesFound,
    mediaFound: stats.mediaFound,
    jsonFound: stats.jsonFound,
    serverDuplicatesSkipped: stats.serverDuplicatesSkipped,
    localDuplicatesSkipped: stats.localDuplicatesSkipped,
    stagedFiles: stats.stagedFiles,
    stagedBytes: stats.stagedBytes,
    deferredFiles: stats.deferredFiles,
    deferredBytes: stats.deferredBytes,
    wastedWriteFiles: stats.wastedWriteFiles,
    wastedWriteBytes: stats.wastedWriteBytes,
    fetchFiles: stats.fetchFiles,
    fetchBytesTotal: stats.fetchBytesTotal,
    fetchBytesRead: stats.fetchBytesRead,
    sampleBackfillFiles: stats.sampleBackfillFiles,
    directoryBytesRead: stats.directoryBytesRead,
    transportRetries: stats.transportRetries,
    etaSeconds: stats.etaSeconds,
    discardedStagedFiles: stats.discardedStagedFiles,
    discardedStagedBytes: stats.discardedStagedBytes,
    stagingBytes: stats.stagingBytes,
    stagingExpiresAt: stats.stagingExpiresAt,
    pausedMs: Math.max(0, Math.round(stats.pausedMs)),
    parts,
  };
}

export function mapRun(run: any, rotationCounts?: Record<string, number>): TakeoutRunDto {
  const counters = (run.counters ?? {}) as any;
  if (rotationCounts && counters.result) {
    counters.result = {
      ...counters.result,
      rotationsApplied: rotationCounts['applied'] ?? counters.result.rotationsApplied ?? 0,
      rotationsQueued: rotationCounts['pending'] ?? counters.result.rotationsQueued ?? 0,
    };
  }
  return {
    id: run.id,
    exportId: run.exportId,
    status: run.status,
    importAnyway: run.importAnyway,
    settings: mergeSettings(run.settings) as TakeoutSettingsDto,
    counters: normalizeCounters(counters),
    bytesTotal: Number(run.bytesTotal ?? 0),
    bytesDone: Number(run.bytesDone ?? 0),
    archiveBytesTotal: Number(run.archiveBytesTotal ?? 0),
    archiveBytesRead: Math.min(
      Number(run.archiveBytesRead ?? 0),
      Math.max(Number(run.archiveBytesTotal ?? 0), 0) || Infinity,
    ),
    readStats: mapReadStats(run.readStats),
    hasStaging: !!run.hasStaging,
    supersededBy: run.supersededBy ?? null,
    ...mapPause(run),
    currentFile: run.currentFile,
    error: run.error,
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    createdAt: iso(run.createdAt)!,
  };
}

/** The pause of a paused run (null otherwise): since when, and the status Resume returns to */
function mapPause(run: { status: string; readStats?: unknown }): {
  pausedAt: string | null;
  pausedFrom: TakeoutRunStatus | null;
} {
  if (run.status !== TakeoutRunStatus.Paused) {
    return { pausedAt: null, pausedFrom: null };
  }
  const { pausedAt, pausedFrom } = pauseStateOf(run.readStats);
  const at = pausedAt ? new Date(pausedAt) : null;
  const from = Object.values(TakeoutRunStatus).find((status) => status === pausedFrom) ?? null;
  return { pausedAt: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null, pausedFrom: from };
}

export function normalizeCounters(c: any) {
  const empty = {
    scanned: {
      files: 0,
      images: 0,
      videos: 0,
      assetJsons: 0,
      albumJsons: 0,
      unknownJsons: 0,
      useless: 0,
      unsupported: 0,
      banned: 0,
      sidecars: 0,
    },
    matched: { fastTrack: 0, normal: 0, forgottenDuplicates: 0, edited: 0, missingMetadata: 0 },
    discarded: {
      localDuplicates: 0,
      duplicatedInDirectory: 0,
      filteredPartner: 0,
      filteredTrashed: 0,
      filteredArchived: 0,
      filteredDateRange: 0,
      notSelected: 0,
      rotateOnlyDropped: 0,
      failedVideos: 0,
      previouslyDeleted: 0,
      unreadable: 0,
      missingFromArchive: 0,
    },
    result: {
      toUpload: 0,
      uploaded: 0,
      serverDuplicates: 0,
      betterOnServer: 0,
      alreadyProcessed: 0,
      largerUploaded: 0,
      stacked: 0,
      albumsCreated: 0,
      albumAdds: 0,
      tagged: 0,
      metadataSaved: 0,
      rotationsQueued: 0,
      rotationsApplied: 0,
      zoneAssumed: 0,
      errors: 0,
    },
    bytes: { total: 0, done: 0 },
  };
  return {
    scanned: { ...empty.scanned, ...c?.scanned },
    matched: { ...empty.matched, ...c?.matched },
    discarded: { ...empty.discarded, ...c?.discarded },
    result: { ...empty.result, ...c?.result },
    bytes: { ...empty.bytes, ...c?.bytes },
  };
}

const KNOWN_REASONS = new Set<string>(ANALYSIS_REASONS);
const SIZE_CHECKS = new Set<string>(Object.values(TakeoutSizeCheck));

/** Every field defaulted, reasons that no longer exist (not_scanned) dropped: stored analyses may predate them */
const pathSample = (value: any) => ({
  count: Number(value?.count ?? 0),
  sample: Array.isArray(value?.sample) ? (value.sample as string[]) : [],
});

export function mapAnalysis(analysis: any): TakeoutAnalysisDto {
  const a = analysis ?? {};
  const sample = pathSample;
  return {
    splitSize: a.splitSize ?? null,
    missingParts: a.missingParts ?? [],
    smallParts: a.smallParts ?? [],
    corruptParts: a.corruptParts ?? [],
    lastPartMayBeMissing: a.lastPartMayBeMissing ?? false,
    indexMissingFiles: sample(a.indexMissingFiles),
    notInIndex: a.notInIndex ?? 0,
    jsonWithoutMedia: sample(a.jsonWithoutMedia),
    mediaWithoutJson: sample(a.mediaWithoutJson),
    indexTotalBytes: a.indexTotalBytes ?? null,
    partsTotalBytes: a.partsTotalBytes ?? 0,
    sizeCheck: SIZE_CHECKS.has(a.sizeCheck) ? a.sizeCheck : TakeoutSizeCheck.Unknown,
    listingChecked: a.listingChecked ?? false,
    lastReadAt: a.lastReadAt ?? null,
    lastReadRunId: a.lastReadRunId ?? null,
    unreadableParts: (a.unreadableParts ?? []).map((p: any) => ({
      fileName: p.fileName,
      error: p.error,
      offset: p.offset ?? null,
      size: Number(p.size ?? 0),
    })),
    unreadableEntries: a.unreadableEntries ?? 0,
    reasons: (a.reasons ?? []).filter((reason: string) => KNOWN_REASONS.has(reason)),
  };
}

export function mapUpload(upload: any, offset = 0): TakeoutUploadDto {
  const stale = upload.updatedAt ? Date.now() - new Date(upload.updatedAt).getTime() > STALE_UPLOAD_MS : false;
  return {
    id: upload.id,
    fileName: upload.fileName,
    size: Number(upload.size),
    offset,
    chunkSize: UPLOAD_CHUNK_SIZE,
    stale,
  };
}

export function mapRunFile(row: any) {
  const plan = (row.plan ?? {}) as { albums?: { title: string }[]; tags?: string[] };
  return {
    id: Number(row.id),
    takeoutPath: row.takeoutPath,
    partName: row.partName,
    size: Number(row.size),
    fileKind: row.fileKind,
    jsonPath: row.jsonPath,
    matcher: row.matcher,
    originalFileName: row.originalFileName,
    groupIndex: row.groupIndex,
    groupKind: row.groupKind,
    isCover: row.isCover,
    action: row.action,
    status: row.status,
    reason: row.reason,
    assetId: row.assetId,
    captureDate: iso(row.captureDate),
    zone: row.zone,
    zoneSource: row.zoneSource,
    fallbacks: reportFallbacks(row.fallbacks),
    albums: (plan.albums ?? []).map((a) => a.title),
    tags: plan.tags ?? [],
    rotation: row.rotation ?? 0,
    rotationState: row.rotationState,
    error: row.error,
  };
}
