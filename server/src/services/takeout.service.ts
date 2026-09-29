import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { constants } from 'node:fs';
import { access, mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sanitize from 'sanitize-filename';
import { StorageCore } from 'src/cores/storage.core';
import { OnEvent } from 'src/decorators';
import { mapAsset } from 'src/dtos/asset-response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  TakeoutExportDetailDto,
  TakeoutExportDto,
  TakeoutLargerVersionAction,
  TakeoutLargerVersionDto,
  TakeoutLargerVersionFilter,
  TakeoutLargerVersionResolveDto,
  TakeoutLargerVersionSearchDto,
  TakeoutOverviewDto,
  TakeoutRunCreateDto,
  TakeoutRunDto,
  TakeoutRunFilePageDto,
  TakeoutRunFileQueryDto,
  TakeoutSettingsDto,
  TakeoutSettingsUpdateDto,
  TakeoutUploadCreateDto,
  TakeoutUploadDto,
} from 'src/dtos/takeout.dto';
import {
  AssetStatus,
  ImmichWorker,
  JobName,
  TakeoutArchiveKind,
  TakeoutCatalogStatus,
  TakeoutLargerVersionStatus,
  TakeoutRunFileStatus,
  TakeoutRunStatus,
} from 'src/enum';
import { TAKEOUT_RUNNING_RUN_STATUSES } from 'src/repositories/takeout.repository';
import { BaseService } from 'src/services/base.service';
import { isStablePart } from 'src/services/takeout-analyze.service';
import {
  LifecycleDeps,
  TAKEOUT_ROOT_FOLDER,
  cleanupCancelledRun,
  discardRunStaging,
  openRunStaging,
  reclaimRunTargets,
  takeoutFolderPath,
} from 'src/services/takeout-lifecycle';
import {
  UPLOAD_CHUNK_SIZE,
  mapAnalysis,
  mapExport,
  mapPart,
  mapRun,
  mapRunFile,
  mapUpload,
  reportFallbacks,
} from 'src/services/takeout-mappers';
import { DEFAULT_READ_LIMITS } from 'src/services/takeout-read';
import { STAGING_TTL_MS, isTrashName, isUuid, listStaging, trashStagingDir } from 'src/services/takeout-staging';
import { FolderFile, TakeoutSettings, groupExports, mergeSettings, validateSettings } from 'src/takeout';
import { JobItem } from 'src/types';

export { TAKEOUT_ROOT_FOLDER } from 'src/services/takeout-lifecycle';
export { reportFallbacks } from 'src/services/takeout-mappers';

const MAX_PUT_CHUNK = 64 * 1024 * 1024;
const PART_NAME_RE = /^takeout-\d{8}T\d{6}Z-(?:\d+-)?\d{3}\.(?:zip|tgz|tar\.gz)$/i;
const SYNC_INTERVAL_MS = 60_000;
const SWEEP_INTERVAL_MS = 6 * 3_600_000;
/** staging entries changed within this time are never swept (a run may be about to adopt or write them) */
const SWEEP_MIN_AGE_MS = 3_600_000;
const MAX_ACTIVE_UPLOAD_WRITES = 8;
const STALE_RUN_MS = 60_000;

/**
 * An analysis made while a part was still being copied (reason part_unstable) is made again once every present media
 * part is stable. Stability is a matter of time (ctime older than 30 s), not a file change, so without this the
 * export would keep "uncertain" after every drop or upload that a sync saw while it was being written.
 */
export function awaitsStableParts(
  exp: { id: string; analysis: unknown },
  parts: Array<{ exportId: string; isIndex: boolean; isMissing: boolean; ctime: Date; size: any; prevSyncSize: any }>,
  now = Date.now(),
): boolean {
  const reasons = (exp.analysis as { reasons?: unknown } | null)?.reasons;
  if (!Array.isArray(reasons) || !reasons.includes('part_unstable')) {
    return false;
  }
  const media = parts.filter((p) => p.exportId === exp.id && !p.isIndex && !p.isMissing);
  return media.length > 0 && media.every((p) => isStablePart(p, now));
}

@Injectable()
export class TakeoutService extends BaseService {
  private uploadChains = new Map<string, Promise<unknown>>();
  private activeUploadWrites = new Map<string, number>();
  private syncTimer: NodeJS.Timeout | null = null;
  private lastSweep = 0;

  private get lifecycle(): LifecycleDeps {
    return {
      takeout: this.takeoutRepository,
      asset: this.assetRepository,
      job: this.jobRepository,
      websocket: this.websocketRepository,
      logger: this.logger,
    };
  }

  // ---------- storage helpers ----------

  private rootFolder() {
    return join(StorageCore.getMediaLocation(), TAKEOUT_ROOT_FOLDER);
  }

  private userFolderPath(folderName: string) {
    return join(this.rootFolder(), folderName);
  }

  // ---------- lifecycle events ----------

  @OnEvent({ name: 'UserCreate' })
  async onUserCreate({ id, name, storageLabel }: { id: string; name: string; storageLabel: string | null }) {
    await this.ensureUserFolder({ id, name, storageLabel }).catch((error: Error) =>
      this.logger.warn(`Could not create takeout folder for user ${id}: ${error.message}`),
    );
  }

  @OnEvent({ name: 'UserTrash' })
  async onUserTrash({ id }: { id: string }) {
    const runs = await this.takeoutRepository.getActiveRunsByUser(id);
    for (const run of runs) {
      if (await this.takeoutRepository.requestCancel(run.id)) {
        this.websocketRepository.serverSend('TakeoutRunCancel', { runId: run.id });
      }
    }
  }

  @OnEvent({ name: 'UserDelete' })
  async onUserDelete({ id }: { id: string }) {
    const folder = await this.takeoutRepository.getFolder(id);
    if (!folder) {
      return;
    }
    // the whole folder goes, staging included
    await rm(this.userFolderPath(folder.folderName), { recursive: true, force: true }).catch(() => {});
    await this.takeoutRepository.deleteFolder(id);
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap() {
    await this.recoverAtBoot();
    this.syncTimer = setInterval(() => {
      void this.syncAllUsers().catch((error: Error) => this.logger.warn(`Takeout timer sync failed: ${error.message}`));
      if (Date.now() - this.lastSweep >= SWEEP_INTERVAL_MS) {
        this.lastSweep = Date.now();
        void this.sweepStaging().catch((error: Error) =>
          this.logger.warn(`Takeout staging sweep failed: ${error.message}`),
        );
      }
    }, SYNC_INTERVAL_MS);
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    if (!this.syncTimer) {
      return;
    }

    clearInterval(this.syncTimer);
    this.syncTimer = null;
  }

  /** Boot recovery (single-pass design 10.5) */
  async recoverAtBoot() {
    // 1. provision folders for all live users
    await this.wrapStep('ensure folders', async () => {
      const users = await this.userRepository.getList({ withDeleted: false });
      for (const user of users) {
        await this.ensureUserFolder(user).catch((error: Error) =>
          this.logger.warn(`Could not ensure takeout folder for ${user.id}: ${error.message}`),
        );
      }
    });

    // 3. parts left 'reading' by a run that is not running any more
    await this.wrapStep('reset reading parts', () => this.takeoutRepository.resetReadingParts());

    // 4. runs left non-final by a crash: re-queued (a cancelling one finishes as cancelled in its job)
    await this.wrapStep('recover runs', async () => {
      const runs = await this.takeoutRepository.getInterruptedRuns();
      for (const run of runs) {
        await this.takeoutRepository.updateRun(run.id, {
          heartbeatAt: null,
          leaseToken: null,
          attempt: run.attempt + 1,
        });
        await this.queueUnique(
          { name: JobName.TakeoutRun, data: { runId: run.id, attempt: run.attempt + 1 } },
          `${run.id}/${run.attempt + 1}`,
        );
      }
    });

    // 5. final runs that still hold asset-less files under upload/ (runs of the old code after the upgrade, or a
    // failure or cancel path that could not reach the share). A run that keeps its staging (or a failed run within
    // the staging TTL: the upgrade failed the old importing runs without one) gets complete files back into staging
    // and partial ones unlinked; a run without staging (discarded, expired, completed) never gets a staging
    // directory again: its files are unlinked.
    await this.wrapStep('reclaim targets', async () => {
      for (const listed of await this.takeoutRepository.getStoppedRunsWithTargets()) {
        await this.takeoutRepository.withUserSyncLock(listed.userId, async () => {
          // a Resume (under this lock) may have queued the run since the listing: its job reclaims it
          const run = await this.takeoutRepository.getRun(listed.id);
          if (!run || run.status !== listed.status) {
            return;
          }
          const finishedAt = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
          const keepsStaging =
            run.hasStaging || (run.status === TakeoutRunStatus.Failed && Date.now() - finishedAt < STAGING_TTL_MS);
          const folder = keepsStaging ? await this.takeoutRepository.getFolder(run.userId) : undefined;
          const store = folder ? await openRunStaging(this.lifecycle, run, folder.folderName) : null;
          await reclaimRunTargets(this.lifecycle, run.id, store, store ? 'stage' : 'unlink');
        });
      }
    });

    // 6. exports needing analysis
    await this.wrapStep('queue analysis', async () => {
      const pendingExports = await this.takeoutRepository.getExportsNeedingAnalysis();
      for (const exp of pendingExports) {
        await this.queueUnique({ name: JobName.TakeoutAnalyzeExport, data: { exportId: exp.id } }, exp.id);
      }
    });

    // 7. staging sweep, not awaited
    this.lastSweep = Date.now();
    void this.sweepStaging().catch((error: Error) =>
      this.logger.warn(`Takeout staging sweep failed: ${error.message}`),
    );

    // 8. orphan folders (user gone)
    await this.wrapStep('remove orphan folders', async () => {
      const orphans = await this.takeoutRepository.getOrphanFolders();
      for (const orphan of orphans) {
        await rm(this.userFolderPath(orphan.folderName), { recursive: true, force: true }).catch(() => {});
        await this.takeoutRepository.deleteFolder(orphan.userId);
      }
    });
  }

  private async wrapStep(label: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (error: any) {
      this.logger.warn(`Takeout boot step "${label}" failed: ${error?.message ?? error}`);
    }
  }

  private async syncAllUsers() {
    const users = await this.userRepository.getList({ withDeleted: false });
    for (const user of users) {
      await this.syncUserFolder(user.id).catch((error: Error) =>
        this.logger.warn(`Takeout sync failed for ${user.id}: ${error.message}`),
      );
    }
  }

  /**
   * Staging sweep (single-pass design 5.3), per user under the sync lock: trash is deleted; run directories are kept
   * while their run runs, while a failed or cancelled run holds them within the TTL, and while the run that adopts
   * them runs; anything else goes. An expired run is claimed with a check-and-set first, so a run resumed between the
   * listing and the claim keeps its directory.
   */
  async sweepStaging(now = Date.now()) {
    for (const folder of await this.takeoutRepository.getAllFolders()) {
      const userFolder = this.userFolderPath(folder.folderName);
      await this.takeoutRepository.withUserSyncLock(folder.userId, async () => {
        for (const entry of await listStaging(userFolder)) {
          if (isTrashName(entry.name)) {
            await trashStagingDir(userFolder, entry.name, undefined, this.logger);
            continue;
          }
          if (now - entry.mtimeMs < SWEEP_MIN_AGE_MS) {
            continue;
          }
          if (isUuid(entry.name) && !(await this.stagingRemovable(entry.name, now))) {
            continue;
          }
          // anything that is not a run directory (a stray file or folder) goes too
          await trashStagingDir(userFolder, entry.name, undefined, this.logger, { anyChild: true });
        }
      });
    }
  }

  private async stagingRemovable(runId: string, now: number): Promise<boolean> {
    const run = await this.takeoutRepository.getRun(runId);
    if (!run) {
      return true;
    }
    if (TAKEOUT_RUNNING_RUN_STATUSES.includes(run.status) || run.status === TakeoutRunStatus.Cancelling) {
      return false;
    }
    if (run.supersededBy) {
      const successor = await this.takeoutRepository.getRun(run.supersededBy);
      return !(successor && TAKEOUT_RUNNING_RUN_STATUSES.includes(successor.status));
    }
    const stopped = run.status === TakeoutRunStatus.Failed || run.status === TakeoutRunStatus.Cancelled;
    if (stopped && run.hasStaging) {
      const finishedAt = run.finishedAt ? new Date(run.finishedAt).getTime() : now;
      if (now - finishedAt < STAGING_TTL_MS) {
        return false;
      }
      // TTL: the staging goes, the run keeps its status and stays resumable (fetching reads again what it needs)
      return this.takeoutRepository.claimExpiredStaging(runId, STAGING_TTL_MS);
    }
    return true;
  }

  // ---------- folder provisioning ----------

  private async ensureUserFolder(user: { id: string; name: string; storageLabel: string | null }): Promise<string> {
    const existing = await this.takeoutRepository.getFolder(user.id);
    if (existing) {
      await mkdir(this.userFolderPath(existing.folderName), { recursive: true });
      return existing.folderName;
    }

    const baseName = this.baseFolderName(user);
    const taken = new Set<string>();
    for (const folder of await this.takeoutRepository.getAllFolders()) {
      if (folder.userId !== user.id) {
        taken.add(folder.folderName.toLowerCase());
      }
    }
    try {
      for (const entry of await readdir(this.rootFolder(), { withFileTypes: true })) {
        if (entry.isDirectory()) {
          taken.add(entry.name.toLowerCase());
        }
      }
    } catch {
      // root may not exist yet
    }

    let candidate = baseName;
    let suffix = 2;
    while (taken.has(candidate.toLowerCase())) {
      candidate = `${baseName}-${suffix++}`;
    }

    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await this.takeoutRepository.createFolder({ userId: user.id, folderName: candidate });
        await mkdir(this.userFolderPath(candidate), { recursive: true });
        return candidate;
      } catch (error: any) {
        // unique violation: another folder took the name, try the next suffix
        const again = await this.takeoutRepository.getFolder(user.id);
        if (again) {
          await mkdir(this.userFolderPath(again.folderName), { recursive: true });
          return again.folderName;
        }
        candidate = `${baseName}-${suffix++}`;
        if (attempt === 19) {
          throw error;
        }
      }
    }
    throw new Error('Could not pick a takeout folder name');
  }

  private baseFolderName(user: { id: string; name: string; storageLabel: string | null }): string {
    const source = user.storageLabel || user.name || '';
    let name = sanitize(source);
    name = name.replaceAll(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 64).trim();
    return name || user.id;
  }

  // ---------- queue helper ----------

  private async queueUnique(item: JobItem, jobId: string) {
    await this.jobRepository.removeJob(item.name, jobId).catch(() => {});
    await this.jobRepository.queue(item);
  }

  // ---------- overview / sync ----------

  async getOverview(auth: AuthDto): Promise<TakeoutOverviewDto> {
    await this.syncUserFolder(auth.user.id);
    return this.buildOverview(auth.user.id);
  }

  async sync(auth: AuthDto): Promise<TakeoutOverviewDto> {
    await this.syncUserFolder(auth.user.id);
    return this.buildOverview(auth.user.id);
  }

  private async buildOverview(userId: string): Promise<TakeoutOverviewDto> {
    const folder = await this.takeoutRepository.getFolder(userId);
    const folderName = folder?.folderName ?? '';
    const exportRows = await this.takeoutRepository.getExportsByUser(userId);
    const parts = await this.takeoutRepository.getPartsByUser(userId);
    const uploads = await this.takeoutRepository.getUploads(userId);
    const activeRun = await this.takeoutRepository.getActiveRun(userId);
    const pending = await this.takeoutRepository.countPendingLargerVersions(userId);

    const partsByExport = new Map<string, typeof parts>();
    for (const part of parts) {
      const list = partsByExport.get(part.exportId) ?? [];
      list.push(part);
      partsByExport.set(part.exportId, list);
    }

    const exportDtos: TakeoutExportDto[] = [];
    for (const exp of exportRows) {
      const runs = await this.takeoutRepository.getRunsByExport(exp.id);
      exportDtos.push(mapExport(exp, partsByExport.get(exp.id) ?? [], runs[0] ?? null));
    }

    const otherFiles = await this.listOtherFiles(folderName, uploads);
    // offset = bytes already in the .part file, so paused uploads show their real progress
    const uploadDtos: TakeoutUploadDto[] = [];
    for (const upload of uploads) {
      const partPath = `${this.userFolderPath(join(folderName, upload.fileName))}.part`;
      uploadDtos.push(mapUpload(upload, await this.partSize(partPath)));
    }

    return {
      folder: { name: folderName, hostPath: `${TAKEOUT_ROOT_FOLDER}/${folderName}` },
      exports: exportDtos,
      orphanIndexFiles: [],
      uploads: uploadDtos,
      otherFiles,
      activeRun: activeRun ? mapRun(activeRun) : null,
      pendingLargerVersions: pending,
    };
  }

  private async listOtherFiles(folderName: string, uploads: { fileName: string }[]) {
    if (!folderName) {
      return [];
    }
    const uploadNames = new Set(uploads.map((u) => u.fileName));
    const result: { name: string; size: number }[] = [];
    try {
      for (const entry of await readdir(this.userFolderPath(folderName), { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith('.') || entry.name.endsWith('.part')) {
          continue;
        }
        if (PART_NAME_RE.test(entry.name) || uploadNames.has(entry.name)) {
          continue;
        }
        const info = await stat(this.userFolderPath(join(folderName, entry.name))).catch(() => null);
        if (info) {
          result.push({ name: entry.name, size: Number(info.size) });
        }
      }
    } catch {
      // folder missing
    }
    return result;
  }

  /** The cheap folder sync of 2.2: list, stat, group, upsert, queue */
  /** The cheap folder sync of 2.2: list, stat, group, upsert, analyse. It never reads an archive. */
  async syncUserFolder(userId: string): Promise<void> {
    const user = await this.userRepository.getList({ id: userId, withDeleted: true });
    if (user[0]?.deletedAt) {
      return;
    }
    const folderName = await this.ensureUserFolder(user[0] ?? { id: userId, name: '', storageLabel: null }).catch(
      () => null,
    );
    if (!folderName) {
      return;
    }

    const folderPath = this.userFolderPath(folderName);
    const files: FolderFile[] = [];
    try {
      for (const entry of await readdir(folderPath, { withFileTypes: true })) {
        // regular, non-dot files only: .staging and uploads in progress are never parts
        if (!entry.isFile() || entry.name.startsWith('.') || entry.name.endsWith('.part')) {
          continue;
        }
        const info = await stat(join(folderPath, entry.name)).catch(() => null);
        if (info) {
          files.push({ fileName: entry.name, size: Number(info.size), mtime: info.mtime, ctime: info.ctime });
        }
      }
    } catch {
      return;
    }

    await this.takeoutRepository.withUserSyncLock(userId, async () => {
      await this.reconcileFolder(userId, files);
    });
  }

  private async reconcileFolder(userId: string, files: FolderFile[]) {
    const existingExports = await this.takeoutRepository.getExportsByUser(userId);
    const knownIndex = new Set(existingExports.map((e) => e.indexFileName).filter((x): x is string => !!x));
    const rejectedIndex = new Set<string>();
    const grouped = groupExports(files, knownIndex, rejectedIndex);

    const existingParts = await this.takeoutRepository.getPartsByUser(userId);
    const partByName = new Map(existingParts.map((p) => [p.fileName, p]));
    const activeByExport = new Map<string, boolean>();
    for (const exp of existingExports) {
      activeByExport.set(exp.id, !!(await this.takeoutRepository.getActiveRunForExport(exp.id)));
    }

    const seenNames = new Set<string>();
    const changedExports = new Set<string>();

    for (const detected of grouped.exports) {
      // find or create the export row: reuse when a detected part is already attached
      let exportRow = existingExports.find((e) =>
        detected.parts.some((p) => partByName.get(p.fileName)?.exportId === e.id),
      );
      if (exportRow && activeByExport.get(exportRow.id)) {
        // parts of an export with a running run are never touched: the run detects changes itself
        for (const p of detected.parts) {
          seenNames.add(p.fileName);
        }
        continue;
      }
      if (!exportRow) {
        let key = detected.exportKey;
        let n = 2;
        while (existingExports.some((e) => e.exportKey === key)) {
          key = `${detected.exportKey}-${n++}`;
        }
        exportRow = await this.takeoutRepository.createExport({
          userId,
          exportKey: key,
          exportedAt: detected.exportedAt,
        });
        existingExports.push(exportRow as any);
        changedExports.add(exportRow.id);
      }

      for (const part of detected.parts) {
        seenNames.add(part.fileName);
        const prior = partByName.get(part.fileName);
        if (part.isIndex && exportRow.indexFileName !== part.fileName) {
          await this.takeoutRepository.updateExport(exportRow.id, { indexFileName: part.fileName });
          changedExports.add(exportRow.id);
        }
        if (!prior) {
          await this.takeoutRepository.createPart({
            exportId: exportRow.id,
            userId,
            fileName: part.fileName,
            timestamp: part.timestamp,
            segment: part.segment,
            partNumber: part.partNumber,
            kind: part.kind as TakeoutArchiveKind,
            isIndex: part.isIndex,
            size: part.size,
            mtime: part.mtime,
            ctime: part.ctime,
            prevSyncSize: part.size,
          });
          changedExports.add(exportRow.id);
          continue;
        }

        await this.reconcilePart(prior, part, exportRow.id, changedExports);
      }
    }

    // parts that disappeared: their rows go, the part is marked missing
    for (const part of existingParts) {
      if (seenNames.has(part.fileName) || activeByExport.get(part.exportId)) {
        continue;
      }
      if (!part.isMissing) {
        await this.takeoutRepository.markPartMissing(part.id);
        changedExports.add(part.exportId);
      }
    }

    for (const exp of existingExports) {
      if (activeByExport.get(exp.id) || !(changedExports.has(exp.id) || awaitsStableParts(exp, existingParts))) {
        continue;
      }
      await this.takeoutRepository.updateExport(exp.id, { analysisInputsAt: new Date() });
      await this.queueUnique({ name: JobName.TakeoutAnalyzeExport, data: { exportId: exp.id } }, exp.id);
      const partsNow = await this.takeoutRepository.getPartsByExport(exp.id);
      const fresh = await this.takeoutRepository.getExport(exp.id);
      const runsForExport = await this.takeoutRepository.getRunsByExport(exp.id);
      if (fresh) {
        this.websocketRepository.clientSend(
          'on_takeout_export',
          userId,
          mapExport(fresh, partsNow, runsForExport[0] ?? null),
        );
      }
    }
  }

  /**
   * Change detection of one part. A part whose file size or mtime no longer matches the key its rows were written
   * for is not catalogued any more (single-pass design D-7): its rows go and it is read again at the next run.
   */
  private async reconcilePart(
    prior: Awaited<ReturnType<TakeoutService['takeoutRepository']['getPart']>> & object,
    detected: FolderFile & { size: number; mtime: Date; ctime: Date },
    exportId: string,
    changed: Set<string>,
  ) {
    const sizeChanged = Number(prior.size) !== detected.size;
    const mtimeChanged = prior.mtime.getTime() !== detected.mtime.getTime();
    const ctimeChanged = prior.ctime.getTime() !== detected.ctime.getTime();
    const baselineChanged = Number(prior.prevSyncSize ?? -1) !== detected.size;
    if (!prior.isMissing && !sizeChanged && !mtimeChanged && !ctimeChanged && !baselineChanged) {
      return;
    }

    const patch: Parameters<TakeoutService['takeoutRepository']['updatePart']>[1] = {
      size: detected.size,
      mtime: detected.mtime,
      ctime: detected.ctime,
      prevSyncSize: detected.size,
      isMissing: false,
    };
    const keyStale =
      prior.catalogStatus !== TakeoutCatalogStatus.None &&
      (Number(prior.catalogSize ?? -1) !== detected.size ||
        !prior.catalogMtime ||
        prior.catalogMtime.getTime() !== detected.mtime.getTime());
    if (keyStale) {
      await this.takeoutRepository.deleteEntriesOfPart(prior.id);
      Object.assign(patch, {
        catalogStatus: TakeoutCatalogStatus.None,
        catalogVersion: null,
        catalogSize: null,
        catalogMtime: null,
        catalogError: null,
        catalogErrorOffset: null,
        entryCount: null,
      });
    }
    await this.takeoutRepository.updatePart(prior.id, patch);
    if (prior.isMissing || sizeChanged || mtimeChanged || ctimeChanged || keyStale) {
      changed.add(exportId);
    }
  }

  // ---------- exports ----------

  async getExport(auth: AuthDto, id: string): Promise<TakeoutExportDetailDto> {
    const exp = await this.findExport(auth.user.id, id);
    const parts = await this.takeoutRepository.getPartsByExport(id);
    const runs = await this.takeoutRepository.getRunsByExport(id);
    return {
      ...mapExport(exp, parts, runs[0] ?? null),
      parts: parts.map((part) => mapPart(part)),
      analysis: mapAnalysis(exp.analysis),
      runs: runs.map((r) => mapRun(r)),
    };
  }

  /** "Read failed parts again": parts in error go back to not read (their rows deleted); the next run reads them */
  async rescanExport(auth: AuthDto, id: string): Promise<TakeoutExportDetailDto> {
    await this.findExport(auth.user.id, id);
    if (await this.takeoutRepository.getActiveRunForExport(id)) {
      throw new ConflictException('An import of this export is running');
    }
    const parts = await this.takeoutRepository.getPartsByExport(id);
    for (const part of parts) {
      if (part.catalogStatus !== TakeoutCatalogStatus.Error) {
        continue;
      }
      await this.takeoutRepository.deleteEntriesOfPart(part.id);
      await this.takeoutRepository.updatePart(part.id, {
        catalogStatus: TakeoutCatalogStatus.None,
        catalogVersion: null,
        catalogError: null,
        catalogErrorOffset: null,
        entryCount: null,
      });
    }
    await this.takeoutRepository.updateExport(id, { analysisInputsAt: new Date() });
    await this.queueUnique({ name: JobName.TakeoutAnalyzeExport, data: { exportId: id } }, id);
    return this.getExport(auth, id);
  }

  async deleteExportArchives(auth: AuthDto, id: string): Promise<void> {
    await this.findExport(auth.user.id, id);
    if (await this.takeoutRepository.getActiveRunForExport(id)) {
      throw new ConflictException('An import of this export is running');
    }
    // the staged files of stopped runs of this export are useless without the archives
    for (const run of await this.takeoutRepository.getRunsByExport(id)) {
      if (run.status === TakeoutRunStatus.Failed || (run.status === TakeoutRunStatus.Cancelled && run.hasStaging)) {
        await discardRunStaging(this.lifecycle, run.id);
      }
    }
    const folder = await this.takeoutRepository.getFolder(auth.user.id);
    const parts = await this.takeoutRepository.getPartsByExport(id);
    for (const part of parts) {
      if (folder) {
        await unlink(this.userFolderPath(join(folder.folderName, part.fileName))).catch(() => {});
      }
      await this.takeoutRepository.markPartMissing(part.id);
    }
    await this.takeoutRepository.deleteEntriesOfExport(id);
    await this.takeoutRepository.updateExport(id, { archivesDeletedAt: new Date() });
  }

  async deleteExport(auth: AuthDto, id: string): Promise<void> {
    const exp = await this.findExport(auth.user.id, id);
    if (await this.takeoutRepository.getActiveRunForExport(id)) {
      throw new ConflictException('An import of this export is running');
    }
    const parts = await this.takeoutRepository.getPartsByExport(id);
    const allMissing = parts.every((p) => p.isMissing);
    if (!exp.archivesDeletedAt && !allMissing) {
      throw new BadRequestException('Delete the archives before dismissing the export');
    }
    const folder = await this.takeoutRepository.getFolder(auth.user.id);
    for (const run of await this.takeoutRepository.getRunsByExport(id)) {
      // never a file whose asset exists; the staging of every run goes
      await reclaimRunTargets(this.lifecycle, run.id, null, 'unlink');
      if (folder) {
        await trashStagingDir(takeoutFolderPath(folder.folderName), run.id, undefined, this.logger);
      }
    }
    await this.takeoutRepository.deleteExport(id);
  }

  // ---------- runs ----------

  async createRun(auth: AuthDto, exportId: string, dto: TakeoutRunCreateDto): Promise<TakeoutRunDto> {
    const exp = await this.findExport(auth.user.id, exportId);
    if (exp.archivesDeletedAt) {
      throw new ConflictException('The archives of this export were deleted');
    }
    if (exp.completeness !== 'complete' && !dto.importAnyway) {
      throw new BadRequestException('The export is not complete');
    }

    const settingsRow = await this.takeoutRepository.getSettings(auth.user.id);
    const settings = mergeSettings(settingsRow?.settings ?? null);
    const templateVars = {
      date: exp.exportedAt.toISOString().slice(0, 10),
      user: exp.accountEmail?.split('@', 1)[0] ?? auth.user.name,
      // spec 0.4: run start in the home zone, `YYYY-MM-DD HH:mm:ss` (the immich-go session tag format)
      start: DateTime.now().setZone(settings.homeTimeZone).toFormat('yyyy-MM-dd HH:mm:ss'),
    };

    // under the user lock: two requests can never both create a running run (F19)
    const run = await this.takeoutRepository.withUserSyncLock(auth.user.id, async () => {
      if (await this.takeoutRepository.getActiveRun(auth.user.id)) {
        throw new ConflictException('An import is already running');
      }
      const parts = await this.takeoutRepository.getPartsByExport(exportId);
      if (parts.some((p) => !p.isIndex && !p.isMissing && !isStablePart(p))) {
        throw new ConflictException('A part is still being copied');
      }
      // adoption (single-pass design 10.4): the previous failed or cancelled run hands over its staged files
      const previous = await this.takeoutRepository.getAdoptableRun(exportId);
      if (previous) {
        const halfImported = await this.takeoutRepository.countRunFilesByStatus(
          previous.id,
          TakeoutRunFileStatus.Created,
        );
        if (halfImported > 0) {
          throw new ConflictException(
            `Resume or discard the previous import first: ${halfImported} files of it are half imported`,
          );
        }
      }
      await this.checkFreeSpaceReserve(auth.user.id);
      const { run: created } = await this.takeoutRepository.createRunWithAdoption(
        {
          userId: auth.user.id,
          exportId,
          status: TakeoutRunStatus.Queued,
          importAnyway: dto.importAnyway,
          settings: settings as unknown as object,
          templateVars,
        },
        previous?.id ?? null,
      );
      return created;
    });

    await this.queueUnique({ name: JobName.TakeoutRun, data: { runId: run.id, attempt: 0 } }, `${run.id}/0`);
    return mapRun(run);
  }

  /** Run and Resume only need the reserve: the exact need is known after planning (single-pass design 6.8) */
  private async checkFreeSpaceReserve(userId: string) {
    const folder = await this.takeoutRepository.getFolder(userId);
    const usage = await this.storageRepository
      .checkDiskUsage(folder ? this.userFolderPath(folder.folderName) : this.rootFolder())
      .catch(() => null);
    if (usage && usage.available < DEFAULT_READ_LIMITS.freeSpaceReserve) {
      throw new BadRequestException('Not enough free space');
    }
  }

  async getRun(auth: AuthDto, id: string): Promise<TakeoutRunDto> {
    const run = await this.findRun(auth.user.id, id);
    const rotationCounts = await this.takeoutRepository.getRotationCounts(id);
    return mapRun(run, rotationCounts);
  }

  /**
   * Cancel (single-pass design 10.1): a live running run is asked to stop and keeps its staging; a queued or stale
   * one is cleaned up here; on a failed run, or a cancelled one that still holds staging, cancel means Discard.
   */
  async cancelRun(auth: AuthDto, id: string): Promise<TakeoutRunDto> {
    const run = await this.findRun(auth.user.id, id);
    if (run.status === TakeoutRunStatus.Completed) {
      throw new BadRequestException('A completed run cannot be cancelled');
    }
    const stale = !run.heartbeatAt || Date.now() - run.heartbeatAt.getTime() > STALE_RUN_MS;
    if (run.status === TakeoutRunStatus.Failed || (run.status === TakeoutRunStatus.Cancelled && run.hasStaging)) {
      await discardRunStaging(this.lifecycle, id);
    } else if (run.status === TakeoutRunStatus.Cancelled) {
      // nothing held: nothing to do
    } else if (run.status === TakeoutRunStatus.Queued || stale) {
      const cleaned = await this.takeoutRepository.withUserSyncLock(run.userId, () =>
        cleanupCancelledRun(this.lifecycle, id, { token: null, from: [run.status] }),
      );
      if (!cleaned && (await this.takeoutRepository.requestCancel(id))) {
        // the job took the run meanwhile: let it stop
        this.websocketRepository.serverSend('TakeoutRunCancel', { runId: id });
      }
    } else if (TAKEOUT_RUNNING_RUN_STATUSES.includes(run.status) && (await this.takeoutRepository.requestCancel(id))) {
      this.websocketRepository.serverSend('TakeoutRunCancel', { runId: id });
    }
    const fresh = await this.takeoutRepository.getRun(id);
    return mapRun(fresh ?? run);
  }

  /** Shared cancel cleanup (single-pass design 10.1) for callers outside the job */
  async cleanupCancelledRun(runId: string, from: TakeoutRunStatus[] = [TakeoutRunStatus.Queued]) {
    return cleanupCancelledRun(this.lifecycle, runId, { token: null, from });
  }

  async resumeRun(auth: AuthDto, id: string): Promise<TakeoutRunDto> {
    const run = await this.findRun(auth.user.id, id);
    if (run.status !== TakeoutRunStatus.Failed && run.status !== TakeoutRunStatus.Cancelled) {
      throw new BadRequestException('Only a failed or cancelled run can be resumed');
    }
    if (run.supersededBy) {
      throw new ConflictException('A newer import took over this one');
    }
    const attempt = run.attempt + 1;
    await this.takeoutRepository.withUserSyncLock(auth.user.id, async () => {
      const active = await this.takeoutRepository.getActiveRun(auth.user.id);
      if (active && active.id !== id) {
        throw new ConflictException('An import is already running');
      }
      await this.checkFreeSpaceReserve(auth.user.id);
      // check-and-set failed|cancelled -> queued; rows a cancel skipped are planned again (F19)
      if (!(await this.takeoutRepository.requeueRun(id, attempt))) {
        throw new ConflictException('The run changed meanwhile, try again');
      }
    });
    await this.queueUnique({ name: JobName.TakeoutRun, data: { runId: id, attempt } }, `${id}/${attempt}`);
    const fresh = await this.takeoutRepository.getRun(id);
    return mapRun(fresh ?? run);
  }

  async getRunFiles(auth: AuthDto, id: string, dto: TakeoutRunFileQueryDto): Promise<TakeoutRunFilePageDto> {
    await this.findRun(auth.user.id, id);
    const { items, total } = await this.takeoutRepository.getRunFilesPage(
      id,
      { action: dto.action, status: dto.status, search: dto.search },
      dto.page,
      dto.size,
    );
    return {
      items: items.map((item) => mapRunFile(item)),
      total,
      hasNextPage: dto.page * dto.size < total,
    };
  }

  async getRunReport(auth: AuthDto, id: string): Promise<Readable> {
    await this.findRun(auth.user.id, id);
    const repo = this.takeoutRepository;
    async function* rows() {
      const header = [
        'takeoutPath',
        'part',
        'size',
        'kind',
        'json',
        'matcher',
        'originalFileName',
        'action',
        'status',
        'reason',
        'assetId',
        'group',
        'groupKind',
        'cover',
        'captureDate',
        'zone',
        'zoneSource',
        'fallbacks',
        'albums',
        'tags',
        'rotation',
        'rotationState',
        'error',
      ];
      yield header.join(',') + '\n';
      for await (const row of repo.streamRunFiles(id)) {
        const plan = (row.plan ?? {}) as { albums?: { title: string }[]; tags?: string[] };
        const cells = [
          row.takeoutPath,
          row.partName ?? '',
          String(row.size),
          row.fileKind,
          row.jsonPath ?? '',
          row.matcher ?? '',
          row.originalFileName ?? '',
          row.action,
          row.status,
          row.reason ?? '',
          row.assetId ?? '',
          row.groupIndex ?? '',
          row.groupKind ?? '',
          row.isCover ? '1' : '',
          row.captureDate ? row.captureDate.toISOString() : '',
          row.zone ?? '',
          row.zoneSource ?? '',
          reportFallbacks(row.fallbacks).join('|'),
          (plan.albums ?? []).map((a) => a.title).join('|'),
          (plan.tags ?? []).join('|'),
          String(row.rotation ?? 0),
          row.rotationState ?? '',
          row.error ?? '',
        ];
        yield cells.map((c) => csvCell(String(c))).join(',') + '\n';
      }
    }
    return Readable.from(rows());
  }

  // ---------- settings ----------

  async getSettings(auth: AuthDto): Promise<TakeoutSettingsDto> {
    const saved = await this.takeoutRepository.getSettings(auth.user.id);
    return mergeSettings((saved?.settings as Partial<TakeoutSettings>) ?? null) as TakeoutSettingsDto;
  }

  async updateSettings(auth: AuthDto, dto: TakeoutSettingsUpdateDto): Promise<TakeoutSettingsDto> {
    const errors = validateSettings(dto as Partial<TakeoutSettings>);
    if (errors.length > 0) {
      throw new BadRequestException(errors.join('; '));
    }
    const currentRow = await this.takeoutRepository.getSettings(auth.user.id);
    const current = currentRow?.settings ?? {};
    const merged = { ...(current as object), ...(dto as object) };
    await this.takeoutRepository.upsertSettings(auth.user.id, merged);
    return mergeSettings(merged as Partial<TakeoutSettings>) as TakeoutSettingsDto;
  }

  // ---------- uploads ----------

  async createUpload(auth: AuthDto, dto: TakeoutUploadCreateDto): Promise<TakeoutUploadDto> {
    if (!PART_NAME_RE.test(dto.fileName)) {
      throw new BadRequestException('Not a Google Takeout archive name');
    }
    if (dto.size === 0) {
      throw new BadRequestException('Size must be positive');
    }
    const folderName = await this.ensureUserFolder(await this.requireUser(auth.user.id));
    const finalPath = this.userFolderPath(join(folderName, dto.fileName));
    if (await this.exists(finalPath)) {
      throw new ConflictException('A file with this name already exists');
    }

    const partPath = `${finalPath}.part`;
    const existing = await this.takeoutRepository.getUploadByName(auth.user.id, dto.fileName);
    if (existing) {
      if (Number(existing.size) === dto.size) {
        if (await this.exists(partPath)) {
          await this.checkUploadSpace(auth.user.id, dto.size, partPath, existing.id);
          return mapUpload(existing, await this.partSize(partPath));
        }
      } else {
        if (await this.exists(partPath)) {
          throw new ConflictException('An upload of this file with a different size exists');
        }
      }
      await this.takeoutRepository.deleteUpload(existing.id);
    }

    await this.checkUploadSpace(auth.user.id, dto.size, partPath, null);
    await mkdir(this.userFolderPath(folderName), { recursive: true });
    const created = await this.takeoutRepository.createUpload({
      userId: auth.user.id,
      fileName: dto.fileName,
      size: dto.size,
    });
    const handle = await open(partPath, 'a');
    await handle.close();
    return mapUpload(created, 0);
  }

  async getUpload(auth: AuthDto, id: string): Promise<TakeoutUploadDto> {
    const upload = await this.findUpload(auth.user.id, id);
    const partPath = await this.uploadPartPath(auth.user.id, upload.fileName);
    return mapUpload(upload, await this.partSize(partPath));
  }

  async writeUploadChunk(
    auth: AuthDto,
    id: string,
    offsetHeader: string | undefined,
    body: Readable,
  ): Promise<TakeoutUploadDto> {
    const upload = await this.findUpload(auth.user.id, id);
    const active = this.activeUploadWrites.get(auth.user.id) ?? 0;
    if (active >= MAX_ACTIVE_UPLOAD_WRITES) {
      throw new ConflictException('Too many concurrent uploads');
    }
    this.activeUploadWrites.set(auth.user.id, active + 1);
    const release = () => {
      const n = (this.activeUploadWrites.get(auth.user.id) ?? 1) - 1;
      if (n <= 0) {
        this.activeUploadWrites.delete(auth.user.id);
      } else {
        this.activeUploadWrites.set(auth.user.id, n);
      }
    };
    const chain = (this.uploadChains.get(id) ?? Promise.resolve())
      .then(() => this.doWriteChunk(auth.user.id, upload, offsetHeader, body))
      .finally(release);
    this.uploadChains.set(
      id,
      chain.catch(() => {}),
    );
    return chain;
  }

  private async doWriteChunk(
    userId: string,
    upload: { id: string; fileName: string; size: any },
    offsetHeader: string | undefined,
    body: Readable,
  ): Promise<TakeoutUploadDto> {
    const folderName = await this.ensureUserFolder(await this.requireUser(userId));
    const partPath = this.userFolderPath(join(folderName, `${upload.fileName}.part`));
    const size = Number(upload.size);
    const offset = Number(offsetHeader ?? '0');
    const currentOffset = await this.partSize(partPath);

    if (offset !== currentOffset) {
      throw new ConflictException(JSON.stringify({ offset: currentOffset }));
    }

    // Stream the request body straight to the .part file at the given offset so peak
    // memory is one socket chunk rather than the whole PUT body. The running total is
    // capped by the smaller of MAX_PUT_CHUNK and the bytes still declared for this upload.
    const cap = Math.min(MAX_PUT_CHUNK, size - offset);
    let written = 0;
    const handle = await open(partPath, 'r+').catch(async () => open(partPath, 'w+'));
    try {
      for await (const chunk of body) {
        const buf = chunk as Buffer;
        if (written + buf.length > cap) {
          throw new BadRequestException(
            written + buf.length > size - offset ? 'Chunk exceeds the declared size' : 'Chunk too large',
          );
        }
        await handle.write(buf, 0, buf.length, offset + written);
        written += buf.length;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.takeoutRepository.touchUpload(upload.id);

    const newOffset = offset + written;
    if (newOffset >= size) {
      const finalPath = this.userFolderPath(join(folderName, upload.fileName));
      await rename(partPath, finalPath);
      await this.takeoutRepository.deleteUpload(upload.id);
      void this.syncUserFolder(userId).catch(() => {});
      return {
        id: upload.id,
        fileName: upload.fileName,
        size,
        offset: size,
        chunkSize: UPLOAD_CHUNK_SIZE,
        stale: false,
      };
    }
    const fresh = await this.takeoutRepository.getUpload(upload.id);
    return mapUpload(fresh ?? { ...upload, createdAt: new Date(), updatedAt: new Date() }, newOffset);
  }

  async deleteUpload(auth: AuthDto, id: string): Promise<void> {
    const upload = await this.findUpload(auth.user.id, id);
    const partPath = await this.uploadPartPath(auth.user.id, upload.fileName);
    await unlink(partPath).catch(() => {});
    await this.takeoutRepository.deleteUpload(id);
  }

  private async checkUploadSpace(userId: string, size: number, partPath: string, ignoreId: string | null) {
    const existingPart = await this.partSize(partPath);
    const otherSessions = await this.takeoutRepository.getAllUploads();
    let otherRemaining = 0;
    for (const session of otherSessions) {
      if (session.id === ignoreId) {
        continue;
      }
      const p = await this.uploadPartPath(session.userId, session.fileName).catch(() => null);
      const onDisk = p ? await this.partSize(p) : 0;
      otherRemaining += Math.max(0, Number(session.size) - onDisk);
    }
    const need = size - existingPart + otherRemaining + 2 ** 30;
    const folder = await this.takeoutRepository.getFolder(userId);
    const usage = await this.storageRepository.checkDiskUsage(
      folder ? this.userFolderPath(folder.folderName) : this.rootFolder(),
    );
    if (usage.available < need) {
      throw new BadRequestException('Not enough free space');
    }
  }

  private async uploadPartPath(userId: string, fileName: string) {
    const folder = await this.takeoutRepository.getFolder(userId);
    if (!folder) {
      throw new BadRequestException('Not found');
    }
    return this.userFolderPath(join(folder.folderName, `${fileName}.part`));
  }

  private async partSize(partPath: string) {
    const info = await stat(partPath).catch(() => null);
    return info ? Number(info.size) : 0;
  }

  // ---------- larger versions ----------

  async getLargerVersions(auth: AuthDto, dto: TakeoutLargerVersionSearchDto): Promise<TakeoutLargerVersionDto[]> {
    const rows = await this.takeoutRepository.getLargerVersions(
      auth.user.id,
      dto.status === TakeoutLargerVersionFilter.Pending
        ? 'pending'
        : dto.status === TakeoutLargerVersionFilter.Resolved
          ? 'resolved'
          : undefined,
    );
    const result: TakeoutLargerVersionDto[] = [];
    for (const row of rows) {
      const dtoRow = await this.mapLargerVersion(auth, row);
      if (dtoRow) {
        result.push(dtoRow);
      }
    }
    return result;
  }

  async resolveLargerVersion(
    auth: AuthDto,
    id: string,
    dto: TakeoutLargerVersionResolveDto,
  ): Promise<TakeoutLargerVersionDto> {
    const row = await this.takeoutRepository.getLargerVersion(id);
    if (!row || row.userId !== auth.user.id) {
      throw new BadRequestException('Not found');
    }
    if (dto.action === TakeoutLargerVersionAction.DeleteSmaller) {
      if (!row.smallerAssetId) {
        throw new ConflictException('The smaller version was already deleted');
      }
      const [larger] = await this.assetRepository.getByIds([row.largerAssetId]);
      const [smaller] = await this.assetRepository.getByIds([row.smallerAssetId]);
      if (!smaller || smaller.ownerId !== auth.user.id || !larger || larger.ownerId !== auth.user.id) {
        throw new BadRequestException('Not found');
      }
      await this.assetRepository.updateAll([row.smallerAssetId], {
        deletedAt: new Date(),
        status: AssetStatus.Trashed,
      });
      await this.eventRepository.emit('AssetTrashAll', { assetIds: [row.smallerAssetId], userId: auth.user.id });
      await this.takeoutRepository.updateLargerVersion(id, {
        status: TakeoutLargerVersionStatus.DeletedSmaller,
        resolvedAt: new Date(),
      });
    } else {
      await this.takeoutRepository.updateLargerVersion(id, {
        status: TakeoutLargerVersionStatus.KeptBoth,
        resolvedAt: new Date(),
      });
    }
    const fresh = await this.takeoutRepository.getLargerVersion(id);
    const mapped = await this.mapLargerVersion(auth, fresh!);
    return mapped!;
  }

  private async mapLargerVersion(auth: AuthDto, row: any): Promise<TakeoutLargerVersionDto | null> {
    const [larger] = await this.assetRepository.getByIds([row.largerAssetId]);
    if (!larger) {
      return null;
    }
    const smallerRows = row.smallerAssetId ? await this.assetRepository.getByIds([row.smallerAssetId]) : [];
    const smaller = smallerRows[0] ?? null;
    return {
      id: row.id,
      runId: row.runId,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      larger: mapAsset(larger as any, { auth, withStack: false }),
      smaller: smaller ? mapAsset(smaller as any, { auth, withStack: false }) : null,
    };
  }

  // ---------- helpers ----------

  private async findExport(userId: string, id: string) {
    const exp = await this.takeoutRepository.getExport(id);
    if (!exp || exp.userId !== userId) {
      throw new BadRequestException('Not found');
    }
    return exp;
  }

  private async findRun(userId: string, id: string) {
    const run = await this.takeoutRepository.getRun(id);
    if (!run || run.userId !== userId) {
      throw new BadRequestException('Not found');
    }
    return run;
  }

  private async findUpload(userId: string, id: string) {
    const upload = await this.takeoutRepository.getUpload(id);
    if (!upload || upload.userId !== userId) {
      throw new BadRequestException('Not found');
    }
    return upload;
  }

  private async requireUser(userId: string) {
    const [user] = await this.userRepository.getList({ id: userId, withDeleted: true });
    if (!user) {
      throw new BadRequestException('Not found');
    }
    return user;
  }

  private async exists(path: string) {
    return access(path, constants.F_OK)
      .then(() => true)
      .catch(() => false);
  }
}

function csvCell(value: string): string {
  // Neutralize spreadsheet formula injection: a cell that starts with a formula
  // trigger is prefixed with a single quote so Excel/Sheets/LibreOffice treat it as text.
  if (/^[=+\-@\t\r]/.test(value)) {
    value = `'${value}`;
  }
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
