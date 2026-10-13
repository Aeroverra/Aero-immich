import { Injectable } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { JobName, JobStatus, QueueName, TakeoutCompleteness } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { emitExport, takeoutFolderPath } from 'src/services/takeout-lifecycle';
import {
  ArchiveBrowserIndex,
  ArchiveKind,
  ExportAnalysisInput,
  ExportAnalysisPart,
  LastReadAnalysis,
  analyzeExport,
  messageOf,
  parseArchiveBrowser,
  parseSizeText,
  pathKey,
  readArchiveEntry,
  readZipDirectory,
} from 'src/takeout';
import { JobOf } from 'src/types';

// Pre-run detection (single-pass design 11): cheap, automatic, no media part is read. The index archive is parsed
// (about 0.5 MB), zip parts give their central directories, and the post-read checks of the last run are merged in.

const STABLE_AGE_MS = 30_000;
const INDEX_READ_LIMIT = 64 * 1024 * 1024;

/** Stable-part rule (spec 2.2 step 7): ctime older than 30 s and size unchanged since the previous sync */
export function isStablePart(part: { ctime: Date; size: any; prevSyncSize: any }, now = Date.now()): boolean {
  return now - new Date(part.ctime).getTime() > STABLE_AGE_MS && Number(part.size) === Number(part.prevSyncSize ?? -1);
}

export function toAnalysisParts(parts: any[], now = Date.now()): ExportAnalysisPart[] {
  return parts.map((p) => ({
    fileName: p.fileName,
    segment: p.segment,
    partNumber: p.partNumber,
    timestamp: p.timestamp,
    size: Number(p.size),
    kind: p.kind as ArchiveKind,
    isIndex: p.isIndex,
    stable: isStablePart(p, now),
    isMissing: !!p.isMissing,
    catalogStatus: p.catalogStatus,
    catalogError: p.catalogError ?? null,
  }));
}

interface StoredAnalysis {
  indexFiles?: string[];
  indexSource?: { fileName: string; size: number; mtime: string };
  indexTotalBytes?: number | null;
  lastRead?: LastReadAnalysis;
  listingKeys?: never;
}

function storedIndex(exp: any, stored: StoredAnalysis): ArchiveBrowserIndex | null {
  if (!Array.isArray(stored.indexFiles)) {
    return null;
  }
  return {
    googleJobId: exp?.googleJobId ?? null,
    accountEmail: exp?.accountEmail ?? null,
    createdText: exp?.indexCreatedText ?? null,
    totalSizeText: exp?.indexTotalSize ?? null,
    services: [],
    files: stored.indexFiles,
  };
}

/** The analysis input from what is stored, plus a new lastRead (the planning step of a run) */
export function storedAnalysisInput(exp: any, parts: any[], lastRead: LastReadAnalysis | null): ExportAnalysisInput {
  const stored = (exp?.analysis ?? {}) as StoredAnalysis;
  return {
    parts: toAnalysisParts(parts),
    index: storedIndex(exp, stored),
    indexTotalBytes: stored.indexTotalBytes ?? parseSizeText(exp?.indexTotalSize) ?? null,
    listingPaths: null,
    corruptListings: [],
    lastRead: lastRead ?? stored.lastRead ?? null,
  };
}

@Injectable()
export class TakeoutAnalyzeService extends BaseService {
  private legacyLogged = false;

  /**
   * Legacy job of the old pass-1 scan: queued, delayed or retried jobs of the previous release drain harmlessly.
   * Remove together with JobName.TakeoutScanPart one release later.
   */
  @OnJob({ name: JobName.TakeoutScanPart, queue: QueueName.Takeout })
  handleScanPart(): JobStatus {
    if (!this.legacyLogged) {
      this.legacyLogged = true;
      this.logger.log('Takeout: ignoring scan jobs of the previous release (single-pass reading replaced them)');
    }
    return JobStatus.Skipped;
  }

  @OnJob({ name: JobName.TakeoutAnalyzeExport, queue: QueueName.Takeout })
  async handleAnalyze({ exportId }: JobOf<JobName.TakeoutAnalyzeExport>): Promise<JobStatus> {
    try {
      const exp = await this.takeoutRepository.getExport(exportId);
      if (!exp) {
        return JobStatus.Skipped;
      }
      if (await this.takeoutRepository.getActiveRunForExport(exportId)) {
        // the run queues the analysis again when it reaches a final state
        return JobStatus.Skipped;
      }
      const parts = await this.takeoutRepository.getPartsByExport(exportId);
      const folder = await this.takeoutRepository.getFolder(exp.userId);
      const stored = { ...(exp.analysis as StoredAnalysis) };

      // 1. index: parsed when missing or when the index file changed
      let index = storedIndex(exp, stored);
      const indexPart = parts.find((p) => p.isIndex);
      let indexChanged = false;
      if (indexPart && folder) {
        const source = {
          fileName: indexPart.fileName,
          size: Number(indexPart.size),
          mtime: indexPart.mtime.toISOString(),
        };
        const known = stored.indexSource;
        const same =
          known && known.fileName === source.fileName && known.size === source.size && known.mtime === source.mtime;
        if (!index || !same) {
          const html = await readArchiveEntry(
            `${takeoutFolderPath(folder.folderName)}/${indexPart.fileName}`,
            'tgz',
            'Takeout/archive_browser.html',
            INDEX_READ_LIMIT,
          ).catch(() => null);
          if (html) {
            index = parseArchiveBrowser(html.toString('utf8'));
            stored.indexFiles = index.files;
            stored.indexSource = source;
            stored.indexTotalBytes = parseSizeText(index.totalSizeText);
            indexChanged = true;
          }
        }
      }

      // 2. zip listings: tail and central directory of every present, stable zip part
      const media = parts.filter((p) => !p.isIndex);
      const present = media.filter((p) => !p.isMissing);
      let listingPaths: Set<string> | null = null;
      const corruptListings: ExportAnalysisInput['corruptListings'] = [];
      if (folder && present.length > 0 && present.every((p) => p.kind === 'zip')) {
        listingPaths = new Set<string>();
        for (const part of present) {
          if (!isStablePart(part)) {
            continue;
          }
          try {
            const directory = await readZipDirectory(`${takeoutFolderPath(folder.folderName)}/${part.fileName}`);
            for (const entry of directory.entries) {
              if (!entry.isDirectory) {
                listingPaths.add(pathKey(entry.name));
              }
            }
          } catch (error) {
            corruptListings.push({ fileName: part.fileName, error: messageOf(error) });
          }
        }
        if (present.some((p) => !isStablePart(p))) {
          // a part still being copied has no reliable listing yet
          listingPaths = null;
        }
      }

      // 3. rules
      const analysis = analyzeExport({
        parts: toAnalysisParts(parts),
        index,
        indexTotalBytes: stored.indexTotalBytes ?? parseSizeText(index?.totalSizeText) ?? null,
        listingPaths,
        corruptListings,
        lastRead: stored.lastRead ?? null,
      });

      await this.takeoutRepository.updateExport(exportId, {
        analysis: { ...stored, ...analysis },
        completeness: analysis.completeness as TakeoutCompleteness,
        splitSize: analysis.splitSize ?? null,
        analyzedAt: new Date(),
        ...(index &&
          indexChanged && {
            accountEmail: index.accountEmail,
            googleJobId: index.googleJobId,
            indexTotalSize: index.totalSizeText,
            indexCreatedText: index.createdText,
            indexFileCount: index.files.length,
          }),
        ...(indexPart && { indexFileName: indexPart.fileName }),
      });

      await emitExport(
        {
          takeout: this.takeoutRepository,
          asset: this.assetRepository,
          job: this.jobRepository,
          websocket: this.websocketRepository,
          logger: this.logger,
        },
        exportId,
      );
      return JobStatus.Success;
    } catch (error: unknown) {
      this.logger.error(`Takeout analysis of export ${exportId} failed: ${messageOf(error)}`);
      return JobStatus.Failed;
    }
  }
}
