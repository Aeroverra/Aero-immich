import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core';
import { OnJob } from 'src/decorators';
import { JobName, JobStatus, QueueName, TakeoutArchiveKind, TakeoutCompleteness, TakeoutScanStatus } from 'src/enum';
import { TakeoutRepository } from 'src/repositories/takeout.repository';
import { BaseService } from 'src/services/base.service';
import { TAKEOUT_ROOT_FOLDER } from 'src/services/takeout.service';
import {
  ArchiveKind,
  CatalogInput,
  ExportAnalysisInput,
  ExportAnalysisPart,
  analyzeExport,
  buildCatalog,
  classifyEntry,
  compactGoogleJson,
  computeImageSample,
  hashTap,
  isDecodable,
  listZipNames,
  parseArchiveBrowser,
  readArchiveEntry,
  samplePairsToKeep,
  walkArchive,
} from 'src/takeout';
import { JobOf } from 'src/types';

const JSON_READ_LIMIT = 4 * 1024 * 1024;
const SAMPLE_BUFFER_LIMIT = 256 * 1024 * 1024;
const BATCH_ROWS = 1000;
const BATCH_JSON_BYTES = 16 * 1024 * 1024;
const HEARTBEAT_MS = 2000;

export interface PartScanResult {
  status: 'scanned' | 'error' | 'aborted' | 'missing';
  error?: string;
  entryCount?: number;
  scannedSize?: number;
  scannedMtime?: Date;
}

@Injectable()
export class TakeoutScanService extends BaseService {
  @OnJob({ name: JobName.TakeoutScanPart, queue: QueueName.Takeout })
  async handleScanPart({ partId }: JobOf<JobName.TakeoutScanPart>): Promise<JobStatus> {
    try {
      const part = await this.takeoutRepository.getPart(partId);
      if (!part) {
        return JobStatus.Skipped;
      }
      const [user] = await this.userRepository.getList({ id: part.userId, withDeleted: true });
      if (!user || user.deletedAt) {
        return JobStatus.Skipped;
      }
      if (await this.takeoutRepository.getActiveRunForExport(part.exportId)) {
        return JobStatus.Skipped; // the run scans it inline
      }
      if (part.scanStatus !== TakeoutScanStatus.Pending) {
        return JobStatus.Skipped;
      }

      const folder = await this.takeoutRepository.getFolder(part.userId);
      if (!folder) {
        return JobStatus.Skipped;
      }
      const filePath = join(StorageCore.getMediaLocation(), TAKEOUT_ROOT_FOLDER, folder.folderName, part.fileName);

      const token = randomUUID();
      const claimed = await this.takeoutRepository.claimPart(partId, token);
      if (!claimed) {
        return JobStatus.Skipped;
      }

      const indexFiles = await this.indexFileList(part.exportId);
      const result = await performPartScan(this.takeoutRepository, claimed, filePath, token, indexFiles);

      if (result.status === 'aborted') {
        return JobStatus.Skipped;
      }
      if (result.status === 'missing') {
        await this.takeoutRepository.updatePart(partId, { scanStatus: TakeoutScanStatus.Missing, scanOwner: null });
        return JobStatus.Skipped;
      }
      if (result.status === 'error') {
        await this.takeoutRepository.updatePart(partId, {
          scanStatus: TakeoutScanStatus.Error,
          scanError: result.error ?? 'scan failed',
          scanOwner: null,
        });
      } else {
        await this.takeoutRepository.updatePart(partId, {
          scanStatus: TakeoutScanStatus.Scanned,
          scannedSize: result.scannedSize,
          scannedMtime: result.scannedMtime,
          entryCount: result.entryCount,
          scanOwner: null,
        });
      }

      // queue the next pending part of this export
      const next = await this.takeoutRepository.getNextPendingPart(part.exportId);
      if (next) {
        await this.jobRepository.removeJob(JobName.TakeoutScanPart, `${next.id}/${next.attempt}`).catch(() => {});
        await this.jobRepository.queue({ name: JobName.TakeoutScanPart, data: { partId: next.id, attempt: next.attempt } });
      }

      await this.finalizeExportScan(part.exportId);
      return JobStatus.Success;
    } catch (error: any) {
      this.logger.error(`Takeout scan of part ${partId} failed: ${error?.message ?? error}`);
      await this.takeoutRepository
        .updatePart(partId, { scanStatus: TakeoutScanStatus.Error, scanError: String(error?.message ?? error), scanOwner: null })
        .catch(() => {});
      return JobStatus.Failed;
    }
  }

  /** Finalize the export scan when every part is terminal (also repeated by the analyze job) */
  async finalizeExportScan(exportId: string) {
    const exp = await this.takeoutRepository.getExport(exportId);
    if (!exp || exp.scanStatus === TakeoutScanStatus.Scanned) {
      return;
    }
    const parts = await this.takeoutRepository.getPartsByExport(exportId);
    const mediaParts = parts.filter((p) => !p.isIndex);
    const allDone = mediaParts.every((p) =>
      [TakeoutScanStatus.Scanned, TakeoutScanStatus.Error, TakeoutScanStatus.Missing].includes(p.scanStatus),
    );
    if (mediaParts.length === 0 || !allDone) {
      return;
    }
    const keep = samplePairsToKeep(await this.takeoutRepository.getMediaEntryPaths(exportId));
    await this.takeoutRepository.pruneSamples(exportId, [...keep]);
    await this.takeoutRepository.updateExport(exportId, {
      scanStatus: TakeoutScanStatus.Scanned,
      analysisInputsAt: new Date(),
    });
    await this.jobRepository.removeJob(JobName.TakeoutAnalyzeExport, exportId).catch(() => {});
    await this.jobRepository.queue({ name: JobName.TakeoutAnalyzeExport, data: { exportId } });
  }

  private async indexFileList(exportId: string): Promise<string[] | null> {
    const exp = await this.takeoutRepository.getExport(exportId);
    if (!exp?.indexFileName) {
      return null;
    }
    const analysis = (exp.analysis ?? {}) as { indexFiles?: string[] };
    return analysis.indexFiles ?? null;
  }

  @OnJob({ name: JobName.TakeoutAnalyzeExport, queue: QueueName.Takeout })
  async handleAnalyze({ exportId }: JobOf<JobName.TakeoutAnalyzeExport>): Promise<JobStatus> {
    try {
      // repeat the scan finalization so a lost race between two finishing scans is repaired
      await this.finalizeExportScan(exportId);

      const exp = await this.takeoutRepository.getExport(exportId);
      if (!exp) {
        return JobStatus.Skipped;
      }
      const parts = await this.takeoutRepository.getPartsByExport(exportId);
      const folder = await this.takeoutRepository.getFolder(exp.userId);

      let index = null as ExportAnalysisInput['index'];
      let indexFiles: string[] | null = null;
      const indexPart = parts.find((p) => p.isIndex);
      if (indexPart && folder) {
        const indexPath = join(StorageCore.getMediaLocation(), TAKEOUT_ROOT_FOLDER, folder.folderName, indexPart.fileName);
        const html = await readArchiveEntry(indexPath, 'tgz', 'Takeout/archive_browser.html', 64 * 1024 * 1024).catch(
          () => null,
        );
        if (html) {
          index = parseArchiveBrowser(html.toString('utf8'));
          indexFiles = index.files;
        }
      }

      // when fully scanned and stale, build the catalog for the cross-check
      let catalogPaths: Set<string> | null = null;
      let catalogSummary: ExportAnalysisInput['catalogSummary'] = null;
      const fullyScanned = exp.scanStatus === TakeoutScanStatus.Scanned;
      const stale = !exp.analyzedAt || (exp.analysisInputsAt && exp.analysisInputsAt > exp.analyzedAt);
      if (fullyScanned && stale) {
        const built = await this.buildCatalogForExport(exportId);
        catalogPaths = built.paths;
        catalogSummary = built.summary;
      }

      const analysisParts: ExportAnalysisPart[] = parts.map((p) => ({
        fileName: p.fileName,
        segment: p.segment,
        partNumber: p.partNumber,
        timestamp: p.timestamp,
        size: Number(p.size),
        kind: p.kind as ArchiveKind,
        isIndex: p.isIndex,
        scanStatus: p.scanStatus as ExportAnalysisPart['scanStatus'],
        scanError: p.scanError,
      }));

      const analysis = analyzeExport({
        parts: analysisParts,
        index,
        catalogPaths,
        catalogSummary,
        previous: (exp.analysis as any)?.completeness ? (exp.analysis as any) : null,
      });

      const stored: any = { ...analysis };
      if (indexFiles) {
        stored.indexFiles = indexFiles;
      }

      await this.takeoutRepository.updateExport(exportId, {
        analysis: stored,
        completeness: analysis.completeness as TakeoutCompleteness,
        splitSize: analysis.splitSize ?? null,
        analyzedAt: new Date(),
        ...(index && {
              accountEmail: index.accountEmail,
              googleJobId: index.googleJobId,
              indexTotalSize: index.totalSizeText,
              indexCreatedText: index.createdText,
              indexFileCount: index.files.length,
            }),
        ...(indexPart && { indexFileName: indexPart.fileName }),
      });

      const fresh = await this.takeoutRepository.getExport(exportId);
      const runs = await this.takeoutRepository.getRunsByExport(exportId);
      if (fresh) {
        this.websocketRepository.clientSend('on_takeout_export', fresh.userId, mapExportForEvent(fresh, parts, runs[0]));
      }
      return JobStatus.Success;
    } catch (error: any) {
      this.logger.error(`Takeout analysis of export ${exportId} failed: ${error?.message ?? error}`);
      return JobStatus.Failed;
    }
  }

  private async buildCatalogForExport(exportId: string) {
    const paths = new Set<string>();
    const takeoutRepository = this.takeoutRepository;
    async function* inputs(): AsyncIterable<CatalogInput> {
      for await (const row of takeoutRepository.streamEntriesForExport(exportId)) {
        paths.add(row.path);
        yield {
          partName: row.partName,
          path: row.path,
          size: Number(row.size),
          mtime: row.mtime,
          kind: row.kind as CatalogInput['kind'],
          json: (row.json as CatalogInput['json']) ?? null,
          checksum: row.checksum,
          sample:
            row.width !== null && row.height !== null && row.sample
              ? { width: row.width, height: row.height, sample: row.sample }
              : null,
        };
      }
    }
    const catalog = await buildCatalog(inputs(), { banned: undefined });
    return { paths, summary: catalog.summary };
  }
}

function mapExportForEvent(exp: any, parts: any[], lastRun: any) {
  const mediaParts = parts.filter((p) => !p.isIndex);
  return {
    id: exp.id,
    exportKey: exp.exportKey,
    exportedAt: exp.exportedAt.toISOString(),
    completeness: exp.completeness,
    scanStatus: exp.scanStatus,
    partCount: mediaParts.length,
    totalSize: parts.reduce((s: number, p: any) => s + Number(p.size), 0),
    bytesScanned: parts.reduce((s: number, p: any) => s + Number(p.bytesScanned ?? 0), 0),
    accountEmail: exp.accountEmail,
    indexFileCount: exp.indexFileCount,
    indexTotalSize: exp.indexTotalSize,
    archivesDeletedAt: exp.archivesDeletedAt ? exp.archivesDeletedAt.toISOString() : null,
    lastRun: lastRun
      ? {
          id: lastRun.id,
          exportId: lastRun.exportId,
          status: lastRun.status,
          importAnyway: lastRun.importAnyway,
          settings: lastRun.settings,
          counters: lastRun.counters ?? {},
          bytesTotal: Number(lastRun.bytesTotal ?? 0),
          bytesDone: Number(lastRun.bytesDone ?? 0),
          archiveBytesTotal: Number(lastRun.archiveBytesTotal ?? 0),
          archiveBytesRead: Number(lastRun.archiveBytesRead ?? 0),
          currentFile: lastRun.currentFile,
          error: lastRun.error,
          startedAt: lastRun.startedAt ? lastRun.startedAt.toISOString() : null,
          finishedAt: lastRun.finishedAt ? lastRun.finishedAt.toISOString() : null,
          createdAt: lastRun.createdAt.toISOString(),
        }
      : null,
  };
}

/** The core pass-1 scan of a single, already-claimed part (2.4); shared by the scan job and a run */
export async function performPartScan(
  repo: TakeoutRepository,
  part: {
    id: string;
    exportId: string;
    kind: string;
    size: any;
    mtime: Date;
    scanStartSize: any;
    scanStartMtime: Date | null;
    scanOwner: string | null;
  },
  filePath: string,
  token: string,
  indexFiles: string[] | null,
  signal?: AbortSignal,
): Promise<PartScanResult> {
  const kind = part.kind as TakeoutArchiveKind;
  const isZip = kind === TakeoutArchiveKind.Zip;

  // sampling set
  let sampleSet: Set<string> | 'all';
  if (isZip) {
    sampleSet = samplePairsToKeep(await listZipNames(filePath));
  } else if (indexFiles) {
    sampleSet = samplePairsToKeep(indexFiles);
  } else {
    sampleSet = 'all';
  }
  const wantSample = (path: string) => (sampleSet === 'all' ? isDecodable(path) : sampleSet.has(path));

  // resume: zip continues from max(seq)+1 when unchanged, tgz always restarts
  let startSeq = 0;
  if (isZip) {
    const maxSeq = await repo.getMaxEntrySeq(part.id);
    if (maxSeq !== null) {
      await repo.deleteEntriesOfPartFromSeq(part.id, Number(maxSeq) + 1);
      startSeq = Number(maxSeq) + 1;
    }
  } else {
    await repo.deleteEntriesOfPart(part.id);
  }

  const controller = new AbortController();
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const batch: any[] = [];
  let batchJsonBytes = 0;
  let entryCount = startSeq;
  let bytesRead = 0;
  let lastHeartbeat = Date.now();
  let aborted = false;

  const flush = async () => {
    if (batch.length === 0) {
      return;
    }
    const rows = [...batch];
    batch.length = 0;
    batchJsonBytes = 0;
    try {
      await repo.insertEntries(rows);
    } catch {
      for (const row of rows) {
        try {
          await repo.insertEntry(row);
        } catch (rowError: any) {
          await repo.insertEntry({ ...row, json: null, jsonError: String(rowError?.message ?? rowError) });
        }
      }
    }
  };

  const heartbeat = async () => {
    lastHeartbeat = Date.now();
    await repo.updatePart(part.id, { bytesScanned: bytesRead, heartbeatAt: new Date() });
    const fresh = await repo.getPart(part.id);
    if (!fresh || fresh.scanOwner !== token) {
      aborted = true;
      controller.abort();
      return;
    }
    if (Number(fresh.size) !== Number(part.scanStartSize ?? part.size) || fresh.mtime.getTime() !== (part.scanStartMtime ?? part.mtime).getTime()) {
      aborted = true;
      controller.abort();
    }
  };

  const handler = async (entry: any, openStream: () => Promise<NodeJS.ReadableStream>) => {
    if (aborted) {
      return;
    }
    const path: string = entry.path;
    const kindOf = classifyEntry(path);
    const row: any = {
      exportId: part.exportId,
      partId: part.id,
      seq: entry.seq,
      path,
      size: entry.size,
      mtime: entry.mtime,
      kind: kindOf,
      checksum: null,
      json: null,
      jsonError: null,
      width: null,
      height: null,
      sample: null,
      sampleSkipped: null,
    };

    if (entry.error) {
      row.kind = 'other';
      row.jsonError = entry.error;
    } else if (kindOf === 'json') {
      if (entry.size <= JSON_READ_LIMIT) {
        try {
          const buf = await streamToBuffer(await openStream(), JSON_READ_LIMIT);
          const text = buf.toString('utf8');
          row.json = text.includes('immich-go version:') ? { immichGo: true } : (compactGoogleJson(JSON.parse(text)) as object);
        } catch (error: any) {
          row.jsonError = String(error?.message ?? error);
        }
      } else {
        row.jsonError = 'json too large';
      }
    } else if (kindOf === 'media') {
      if (wantSample(path)) {
        if (Number(entry.size) <= SAMPLE_BUFFER_LIMIT) {
          const buf = await streamToBuffer(await openStream(), SAMPLE_BUFFER_LIMIT);
          row.checksum = sha1(buf);
          const sample = await computeImageSample(buf);
          applySample(row, sample);
        } else if (isZip) {
          row.checksum = await streamSha1(openStream);
          const sample = await computeImageSample((await openStream()) as any);
          applySample(row, sample);
        } else {
          row.checksum = await streamSha1(openStream);
          row.sampleSkipped = 'tooLarge';
        }
      } else {
        row.checksum = await streamSha1(openStream);
      }
    }
    // sidecar/useless/unsupported/other: size only, drained automatically

    if (row.json) {
      const jsonSize = JSON.stringify(row.json).length;
      batchJsonBytes += jsonSize;
    }
    batch.push(row);
    entryCount = Math.max(entryCount, entry.seq + 1);

    if (batch.length >= BATCH_ROWS || batchJsonBytes >= BATCH_JSON_BYTES) {
      await flush();
    }
    if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
      await heartbeat();
    }
  };

  try {
    await walkArchive(filePath, kind === TakeoutArchiveKind.Zip ? 'zip' : 'tgz', handler as any, {
      signal: controller.signal,
      onBytes: (n) => {
        bytesRead = n;
      },
      startSeq: isZip ? startSeq : undefined,
    });
    await flush();
  } catch (error: any) {
    await flush().catch(() => {});
    if (aborted) {
      return { status: 'aborted' };
    }
    if (error?.code === 'ENOENT') {
      return { status: 'missing' };
    }
    return { status: 'error', error: String(error?.message ?? error) };
  }

  if (aborted) {
    return { status: 'aborted' };
  }
  return {
    status: 'scanned',
    entryCount,
    scannedSize: Number(part.scanStartSize ?? part.size),
    scannedMtime: part.scanStartMtime ?? part.mtime,
  };
}

function applySample(row: any, sample: Awaited<ReturnType<typeof computeImageSample>>) {
  if ('skipped' in sample) {
    row.sampleSkipped = sample.skipped;
  } else {
    row.width = sample.width;
    row.height = sample.height;
    row.sample = sample.sample;
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as any) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > cap) {
      throw new Error('entry exceeds buffer limit');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function streamSha1(openStream: () => Promise<NodeJS.ReadableStream>): Promise<Buffer> {
  const tap = hashTap();
  const stream = await openStream();
  await pipeline(stream as any, tap.stream, new Writable({ write: (_c, _e, cb) => cb() }));
  return tap.result().checksum;
}

function sha1(buffer: Buffer): Buffer {
  return createHash('sha1').update(buffer).digest();
}
