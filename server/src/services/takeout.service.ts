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
  TakeoutPartDto,
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
  TakeoutLargerVersionStatus,
  TakeoutRunFileStatus,
  TakeoutRunStatus,
  TakeoutScanStatus,
} from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { FolderFile, TakeoutSettings, groupExports, mergeSettings, validateSettings } from 'src/takeout';
import { JobItem } from 'src/types';

export const TAKEOUT_ROOT_FOLDER = 'takeouts';

const UPLOAD_CHUNK_SIZE = 32 * 1024 * 1024;
const MAX_PUT_CHUNK = 64 * 1024 * 1024;
const STALE_UPLOAD_MS = 7 * 24 * 60 * 60 * 1000;
const PART_NAME_RE = /^takeout-\d{8}T\d{6}Z-(?:\d+-)?\d{3}\.(?:zip|tgz|tar\.gz)$/i;
const SYNC_INTERVAL_MS = 60_000;
const MAX_ACTIVE_UPLOAD_WRITES = 8;

@Injectable()
export class TakeoutService extends BaseService {
  private uploadChains = new Map<string, Promise<unknown>>();
  private activeUploadWrites = new Map<string, number>();
  private syncTimer: NodeJS.Timeout | null = null;

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
      await this.takeoutRepository.updateRun(run.id, { status: TakeoutRunStatus.Cancelling });
      this.websocketRepository.serverSend('TakeoutRunCancel', { runId: run.id });
    }
  }

  @OnEvent({ name: 'UserDelete' })
  async onUserDelete({ id }: { id: string }) {
    const folder = await this.takeoutRepository.getFolder(id);
    if (!folder) {
      return;
    }
    await rm(this.userFolderPath(folder.folderName), { recursive: true, force: true }).catch(() => {});
    await this.takeoutRepository.deleteFolder(id);
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap() {
    await this.recoverAtBoot();
    this.syncTimer = setInterval(() => {
      void this.syncAllUsers().catch((error: Error) => this.logger.warn(`Takeout timer sync failed: ${error.message}`));
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

  private async recoverAtBoot() {
    // provision folders for all live users
    await this.wrapStep('ensure folders', async () => {
      const users = await this.userRepository.getList({ withDeleted: false });
      for (const user of users) {
        await this.ensureUserFolder(user).catch((error: Error) =>
          this.logger.warn(`Could not ensure takeout folder for ${user.id}: ${error.message}`),
        );
      }
    });

    // parts left scanning by a crash
    await this.wrapStep('reset scanning parts', async () => {
      const users = await this.userRepository.getList({ withDeleted: false });
      for (const user of users) {
        const parts = await this.takeoutRepository.getPartsByUser(user.id);
        for (const part of parts) {
          if (part.scanStatus !== TakeoutScanStatus.Scanning) {
            continue;
          }

          await this.takeoutRepository.updatePart(part.id, {
            scanStatus: TakeoutScanStatus.Pending,
            scanOwner: null,
            attempt: part.attempt + 1,
          });
          await this.queueUnique(
            { name: JobName.TakeoutScanPart, data: { partId: part.id, attempt: part.attempt + 1 } },
            `${part.id}/${part.attempt + 1}`,
          );
        }
      }
    });

    // runs left non-final by a crash
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

    // exports needing analysis
    await this.wrapStep('queue analysis', async () => {
      const pendingExports = await this.takeoutRepository.getExportsNeedingAnalysis();
      for (const exp of pendingExports) {
        await this.queueUnique({ name: JobName.TakeoutAnalyzeExport, data: { exportId: exp.id } }, exp.id);
      }
    });

    // orphan folders (user gone)
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

    return {
      folder: { name: folderName, hostPath: `${TAKEOUT_ROOT_FOLDER}/${folderName}` },
      exports: exportDtos,
      orphanIndexFiles: [],
      uploads: uploads.map((upload) => mapUpload(upload)),
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
        // an export with an active run is not mutated at all
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

        // change detection and stability
        await this.reconcilePart(prior, part, exportRow.id, changedExports);
      }
    }

    // parts that disappeared
    for (const part of existingParts) {
      if (seenNames.has(part.fileName)) {
        continue;
      }
      if (activeByExport.get(part.exportId)) {
        continue;
      }
      if (part.scanStatus !== TakeoutScanStatus.Missing) {
        await this.takeoutRepository.updatePart(part.id, { scanStatus: TakeoutScanStatus.Missing });
        await this.takeoutRepository.deleteEntriesOfPart(part.id);
        changedExports.add(part.exportId);
      }
    }

    // queue one scan per export and the analysis
    for (const exp of existingExports) {
      if (activeByExport.get(exp.id)) {
        continue;
      }
      const next = await this.takeoutRepository.getNextPendingPart(exp.id);
      if (next && this.isStable(next)) {
        await this.queueUnique(
          { name: JobName.TakeoutScanPart, data: { partId: next.id, attempt: next.attempt } },
          `${next.id}/${next.attempt}`,
        );
      }
      if (changedExports.has(exp.id)) {
        await this.takeoutRepository.updateExport(exp.id, { analysisInputsAt: new Date() });
        await this.queueUnique({ name: JobName.TakeoutAnalyzeExport, data: { exportId: exp.id } }, exp.id);
        const partsNow = await this.takeoutRepository.getPartsByExport(exp.id);
        const fresh = await this.takeoutRepository.getExport(exp.id);
        const runsForExport = await this.takeoutRepository.getRunsByExport(exp.id);
        const lastRun = runsForExport[0] ?? null;
        if (fresh) {
          this.websocketRepository.clientSend('on_takeout_export', userId, mapExport(fresh, partsNow, lastRun));
        }
      }
    }
  }

  private async reconcilePart(
    prior: Awaited<ReturnType<TakeoutService['takeoutRepository']['getPart']>> & object,
    detected: FolderFile & { size: number; mtime: Date; ctime: Date },
    exportId: string,
    changed: Set<string>,
  ) {
    const sizeChanged = Number(prior.size) !== detected.size;
    const mtimeChanged = prior.mtime.getTime() !== detected.mtime.getTime();
    const ctimeChanged = prior.ctime.getTime() !== detected.ctime.getTime();

    if (prior.scanStatus === TakeoutScanStatus.Scanned) {
      if (
        Number(prior.scannedSize ?? prior.size) !== detected.size ||
        prior.scannedMtime?.getTime() !== detected.mtime.getTime()
      ) {
        await this.takeoutRepository.deleteEntriesOfPart(prior.id);
        await this.takeoutRepository.updatePart(prior.id, {
          size: detected.size,
          mtime: detected.mtime,
          ctime: detected.ctime,
          scanStatus: TakeoutScanStatus.Pending,
          attempt: prior.attempt + 1,
          prevSyncSize: detected.size,
        });
        changed.add(exportId);
      }
      return;
    }

    if (prior.scanStatus === TakeoutScanStatus.Scanning) {
      // the scanner notices at its next heartbeat; sync just records the new stats
      if (sizeChanged || mtimeChanged || ctimeChanged) {
        const stale = !prior.heartbeatAt || Date.now() - prior.heartbeatAt.getTime() > 120_000;
        await this.takeoutRepository.updatePart(prior.id, {
          size: detected.size,
          mtime: detected.mtime,
          ctime: detected.ctime,
          ...(stale && { scanStatus: TakeoutScanStatus.Pending, scanOwner: null, attempt: prior.attempt + 1 }),
        });
        changed.add(exportId);
      } else if (!prior.heartbeatAt || Date.now() - prior.heartbeatAt.getTime() > 120_000) {
        await this.takeoutRepository.updatePart(prior.id, {
          scanStatus: TakeoutScanStatus.Pending,
          scanOwner: null,
          attempt: prior.attempt + 1,
        });
        changed.add(exportId);
      }
      return;
    }

    if (prior.scanStatus === TakeoutScanStatus.Error || prior.scanStatus === TakeoutScanStatus.Missing) {
      if (sizeChanged || mtimeChanged || ctimeChanged) {
        await this.takeoutRepository.updatePart(prior.id, {
          size: detected.size,
          mtime: detected.mtime,
          ctime: detected.ctime,
          scanStatus: TakeoutScanStatus.Pending,
          attempt: prior.attempt + 1,
          prevSyncSize: detected.size,
        });
        changed.add(exportId);
      }
      return;
    }

    // pending: update stats and the stable-file baseline
    if (sizeChanged || mtimeChanged || ctimeChanged || Number(prior.prevSyncSize ?? -1) !== detected.size) {
      await this.takeoutRepository.updatePart(prior.id, {
        size: detected.size,
        mtime: detected.mtime,
        ctime: detected.ctime,
        prevSyncSize: detected.size,
      });
      changed.add(exportId);
    }
  }

  /** Stable-part rule (2.2 step 7): ctime older than 30 s and size unchanged since the previous sync */
  private isStable(part: { ctime: Date; size: any; prevSyncSize: any }) {
    const ctimeOldEnough = Date.now() - part.ctime.getTime() > 30_000;
    return ctimeOldEnough && Number(part.size) === Number(part.prevSyncSize ?? -1);
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

  async rescanExport(auth: AuthDto, id: string): Promise<TakeoutExportDetailDto> {
    await this.findExport(auth.user.id, id);
    if (await this.takeoutRepository.getActiveRunForExport(id)) {
      throw new ConflictException('An import of this export is running');
    }
    const parts = await this.takeoutRepository.getPartsByExport(id);
    for (const part of parts) {
      if (part.scanStatus === TakeoutScanStatus.Error) {
        await this.takeoutRepository.updatePart(part.id, {
          scanStatus: TakeoutScanStatus.Pending,
          scanError: null,
          attempt: part.attempt + 1,
        });
      }
    }
    const next = await this.takeoutRepository.getNextPendingPart(id);
    if (next) {
      await this.queueUnique(
        { name: JobName.TakeoutScanPart, data: { partId: next.id, attempt: next.attempt } },
        `${next.id}/${next.attempt}`,
      );
    }
    return this.getExport(auth, id);
  }

  async deleteExportArchives(auth: AuthDto, id: string): Promise<void> {
    await this.findExport(auth.user.id, id);
    if ((await this.takeoutRepository.getActiveRunForExport(id)) || (await this.anyScanActive(id))) {
      throw new ConflictException('An import or scan of this export is running');
    }
    const folder = await this.takeoutRepository.getFolder(auth.user.id);
    const parts = await this.takeoutRepository.getPartsByExport(id);
    for (const part of parts) {
      if (folder) {
        await unlink(this.userFolderPath(join(folder.folderName, part.fileName))).catch(() => {});
      }
      await this.takeoutRepository.updatePart(part.id, { scanStatus: TakeoutScanStatus.Missing });
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
    const allMissing = parts.every((p) => p.scanStatus === TakeoutScanStatus.Missing);
    if (!exp.archivesDeletedAt && !allMissing) {
      throw new BadRequestException('Delete the archives before dismissing the export');
    }
    const runs = await this.takeoutRepository.getRunsByExport(id);
    for (const run of runs) {
      const rows = await this.takeoutRepository.getRunFilesWithTargetPath(run.id);
      for (const row of rows) {
        if (row.targetPath && (row.status === 'planned' || row.status === 'written')) {
          await unlink(row.targetPath).catch(() => {});
        }
      }
    }
    await this.takeoutRepository.deleteExport(id);
  }

  private async anyScanActive(exportId: string) {
    const parts = await this.takeoutRepository.getPartsByExport(exportId);
    return parts.some((p) => p.scanStatus === TakeoutScanStatus.Scanning);
  }

  // ---------- runs ----------

  async createRun(auth: AuthDto, exportId: string, dto: TakeoutRunCreateDto): Promise<TakeoutRunDto> {
    const exp = await this.findExport(auth.user.id, exportId);
    if (await this.takeoutRepository.getActiveRun(auth.user.id)) {
      throw new ConflictException('An import is already running');
    }
    if (exp.archivesDeletedAt) {
      throw new ConflictException('The archives of this export were deleted');
    }
    if (exp.completeness !== 'complete' && !dto.importAnyway) {
      throw new BadRequestException('The export is not complete');
    }

    const settingsRow = await this.takeoutRepository.getSettings(auth.user.id);
    const settings = mergeSettings(settingsRow?.settings ?? null);

    await this.preflightFreeSpace(auth.user.id, exportId, dto.importAnyway);

    const templateVars = {
      date: exp.exportedAt.toISOString().slice(0, 10),
      user: exp.accountEmail?.split('@', 1)[0] ?? auth.user.name,
      // spec 0.4: run start in the home zone, `YYYY-MM-DD HH:mm:ss` (the immich-go session tag format)
      start: DateTime.now().setZone(settings.homeTimeZone).toFormat('yyyy-MM-dd HH:mm:ss'),
    };

    const run = await this.takeoutRepository.createRun({
      userId: auth.user.id,
      exportId,
      status: TakeoutRunStatus.Queued,
      importAnyway: dto.importAnyway,
      settings: settings as unknown as object,
      templateVars,
    });

    await this.queueUnique({ name: JobName.TakeoutRun, data: { runId: run.id, attempt: 0 } }, `${run.id}/0`);
    return mapRun(run);
  }

  private async preflightFreeSpace(userId: string, exportId: string, importAnyway: boolean) {
    if (importAnyway) {
      return;
    }
    const folder = await this.takeoutRepository.getFolder(userId);
    const media = await this.takeoutRepository.getMediaBytes(exportId);
    let need = media;
    if (media === 0) {
      const parts = await this.takeoutRepository.getPartsByExport(exportId);
      need = parts.reduce((sum, p) => sum + Number(p.size), 0);
    }
    need = need * 1.15 + 5 * 2 ** 30;
    const usage = await this.storageRepository.checkDiskUsage(
      folder ? this.userFolderPath(folder.folderName) : this.rootFolder(),
    );
    if (usage.available < need) {
      throw new BadRequestException('Not enough free space');
    }
  }

  async getRun(auth: AuthDto, id: string): Promise<TakeoutRunDto> {
    const run = await this.findRun(auth.user.id, id);
    const rotationCounts = await this.takeoutRepository.getRotationCounts(id);
    return mapRun(run, rotationCounts);
  }

  async cancelRun(auth: AuthDto, id: string): Promise<TakeoutRunDto> {
    const run = await this.findRun(auth.user.id, id);
    if (run.status === TakeoutRunStatus.Completed) {
      throw new BadRequestException('A completed run cannot be cancelled');
    }
    if (run.status === TakeoutRunStatus.Cancelled) {
      return mapRun(run);
    }
    const stale = !run.heartbeatAt || Date.now() - run.heartbeatAt.getTime() > 60_000;
    if (run.status === TakeoutRunStatus.Queued || run.status === TakeoutRunStatus.Failed || stale) {
      await this.cleanupCancelledRun(id);
      const fresh = await this.takeoutRepository.getRun(id);
      return mapRun(fresh!);
    }
    await this.takeoutRepository.updateRun(id, { status: TakeoutRunStatus.Cancelling });
    this.websocketRepository.serverSend('TakeoutRunCancel', { runId: id });
    const fresh = await this.takeoutRepository.getRun(id);
    return mapRun(fresh!);
  }

  /** Shared cancel cleanup (2.6): unlink partial and written files, mark rows skipped, set cancelled */
  async cleanupCancelledRun(runId: string) {
    const rows = await this.takeoutRepository.getRunFilesWithTargetPath(runId);
    for (const row of rows) {
      if (!(row.targetPath && (row.status === 'planned' || row.status === 'written'))) {
        continue;
      }

      await unlink(row.targetPath).catch(() => {});
      await this.takeoutRepository.updateRunFile(row.id, { status: TakeoutRunFileStatus.Skipped, reason: 'cancelled' });
    }
    await this.takeoutRepository.updateRun(runId, {
      status: TakeoutRunStatus.Cancelled,
      finishedAt: new Date(),
      leaseToken: null,
    });
    const run = await this.takeoutRepository.getRun(runId);
    await this.jobRepository.removeJob(JobName.TakeoutRun, `${runId}/${run?.attempt ?? 0}`).catch(() => {});
    if (run) {
      this.websocketRepository.clientSend('on_takeout_run', run.userId, mapRun(run));
    }
  }

  async resumeRun(auth: AuthDto, id: string): Promise<TakeoutRunDto> {
    const run = await this.findRun(auth.user.id, id);
    if (run.status !== TakeoutRunStatus.Failed && run.status !== TakeoutRunStatus.Cancelled) {
      throw new BadRequestException('Only a failed or cancelled run can be resumed');
    }
    const active = await this.takeoutRepository.getActiveRun(auth.user.id);
    if (active && active.id !== id) {
      throw new ConflictException('An import is already running');
    }
    await this.preflightFreeSpace(auth.user.id, run.exportId, run.importAnyway);
    await this.takeoutRepository.updateRun(id, {
      status: TakeoutRunStatus.Queued,
      error: null,
      heartbeatAt: null,
      leaseToken: null,
      finishedAt: null,
      attempt: run.attempt + 1,
    });
    await this.queueUnique(
      { name: JobName.TakeoutRun, data: { runId: id, attempt: run.attempt + 1 } },
      `${id}/${run.attempt + 1}`,
    );
    const fresh = await this.takeoutRepository.getRun(id);
    return mapRun(fresh!);
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
          (row.fallbacks ?? []).join('|'),
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

// ---------- DTO mappers ----------

function mapExport(exp: any, parts: any[], lastRun: any): TakeoutExportDto {
  const mediaParts = parts.filter((p) => !p.isIndex);
  const bytesScanned = parts.reduce((sum, p) => sum + Number(p.bytesScanned ?? 0), 0);
  return {
    id: exp.id,
    exportKey: exp.exportKey,
    exportedAt: exp.exportedAt.toISOString(),
    completeness: exp.completeness,
    scanStatus: exp.scanStatus,
    partCount: mediaParts.length,
    totalSize: parts.reduce((sum, p) => sum + Number(p.size), 0),
    bytesScanned,
    accountEmail: exp.accountEmail,
    indexFileCount: exp.indexFileCount,
    indexTotalSize: exp.indexTotalSize,
    archivesDeletedAt: exp.archivesDeletedAt ? exp.archivesDeletedAt.toISOString() : null,
    lastRun: lastRun ? mapRun(lastRun) : null,
  };
}

function mapPart(part: any): TakeoutPartDto {
  return {
    id: part.id,
    fileName: part.fileName,
    segment: part.segment,
    partNumber: part.partNumber,
    kind: part.kind as TakeoutArchiveKind,
    isIndex: part.isIndex,
    size: Number(part.size),
    mtime: part.mtime.toISOString(),
    scanStatus: part.scanStatus,
    bytesScanned: Number(part.bytesScanned ?? 0),
    scanError: part.scanError,
  };
}

function mapRun(run: any, rotationCounts?: Record<string, number>): TakeoutRunDto {
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
    archiveBytesRead: Number(run.archiveBytesRead ?? 0),
    currentFile: run.currentFile,
    error: run.error,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    createdAt: run.createdAt.toISOString(),
  };
}

function normalizeCounters(c: any) {
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
    scanned: { ...empty.scanned, ...c.scanned },
    matched: { ...empty.matched, ...c.matched },
    discarded: { ...empty.discarded, ...c.discarded },
    result: { ...empty.result, ...c.result },
    bytes: { ...empty.bytes, ...c.bytes },
  };
}

function mapAnalysis(analysis: any) {
  const a = analysis ?? {};
  return {
    splitSize: a.splitSize ?? null,
    missingParts: a.missingParts ?? [],
    smallParts: a.smallParts ?? [],
    corruptParts: a.corruptParts ?? [],
    lastPartMayBeMissing: a.lastPartMayBeMissing ?? false,
    indexMissingFiles: a.indexMissingFiles ?? { count: 0, sample: [] },
    notInIndex: a.notInIndex ?? 0,
    jsonWithoutMedia: a.jsonWithoutMedia ?? { count: 0, sample: [] },
    mediaWithoutJson: a.mediaWithoutJson ?? { count: 0, sample: [] },
    reasons: a.reasons ?? [],
  };
}

function mapUpload(upload: any, offset = 0): TakeoutUploadDto {
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

function mapRunFile(row: any) {
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
    captureDate: row.captureDate ? row.captureDate.toISOString() : null,
    zone: row.zone,
    zoneSource: row.zoneSource,
    fallbacks: row.fallbacks ?? [],
    albums: (plan.albums ?? []).map((a) => a.title),
    tags: plan.tags ?? [],
    rotation: row.rotation ?? 0,
    rotationState: row.rotationState,
    error: row.error,
  };
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
