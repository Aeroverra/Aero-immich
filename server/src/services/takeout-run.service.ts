import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink, utimes } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StorageCore } from 'src/cores/storage.core';
import { LockableProperty } from 'src/database';
import { OnEvent, OnJob } from 'src/decorators';
import { AssetEditAction } from 'src/dtos/editing.dto';
import {
  AlbumUserRole,
  AssetFileType,
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  DeletedReimportMode,
  JobName,
  JobStatus,
  NotificationType,
  QueueName,
  StackSource,
  StackUserEditAction,
  StorageFolder,
  TakeoutOnErrors,
  TakeoutRotationState,
  TakeoutRunFileAction,
  TakeoutRunFileStatus,
  TakeoutRunStatus,
  TakeoutScanStatus,
  TakeoutZoneSource,
} from 'src/enum';
import type { ImmichTags } from 'src/repositories/metadata.repository';
import { BaseService } from 'src/services/base.service';
import { assembleStackIds, dedupeTags, hasLocation } from 'src/services/takeout-asset';
import { performPartScan } from 'src/services/takeout-scan.service';
import { TAKEOUT_ROOT_FOLDER } from 'src/services/takeout.service';
import {
  CaptureExifInput,
  CatalogInput,
  DEFAULT_BANNED_PATTERNS,
  ImportPlan,
  buildCatalog,
  countersFromRows,
  hashTap,
  planImport,
  resolveCaptureTime,
  runTags,
  sampleRotationProbe,
  sidecarDateString,
  walkArchive,
  wallTimeAsUtc,
} from 'src/takeout';
import { JobItem, JobOf } from 'src/types';
import { updateLockedColumns } from 'src/utils/database';
import { extractTimeZone, mergeTimeZone } from 'src/utils/date';
import { mimeTypes } from 'src/utils/mime-types';
import { getPreferences } from 'src/utils/preferences';
import { upsertTags } from 'src/utils/tag';

const LEASE_RENEW_MS = 10_000;
// spec 2.6: counters persisted and on_takeout_run emitted every 2 s while the run is live
const PROGRESS_MS = 2000;

const effectiveInstantFor = (capture: { instant?: Date | null }, captureDate: Date | null): Date | null =>
  capture.instant ?? captureDate;

@Injectable()
export class TakeoutRunService extends BaseService {
  private controllers = new Map<string, AbortController>();

  // sent by the API worker with serverSend, so it must listen for server events (spec 2.6 Cancellation)
  @OnEvent({ name: 'TakeoutRunCancel', server: true })
  onCancel({ runId }: { runId: string }) {
    this.controllers.get(runId)?.abort();
  }

  @OnJob({ name: JobName.TakeoutRun, queue: QueueName.Takeout })
  async handleRun({ runId, attempt }: JobOf<JobName.TakeoutRun>): Promise<JobStatus> {
    const run = await this.takeoutRepository.getRun(runId);
    if (!run) {
      return JobStatus.Skipped;
    }
    if (run.status === TakeoutRunStatus.Cancelling) {
      // re-queued at boot while cancelling: finish as cancelled
      await this.finishCancel(runId);
      return JobStatus.Skipped;
    }
    const token = randomUUID();
    if (!(await this.takeoutRepository.takeLease(runId, token))) {
      // another live worker holds the lease: re-queue and let it run
      await this.jobRepository.queue({
        name: JobName.TakeoutRun,
        data: { runId, attempt: attempt + 1, delay: 70_000 },
      });
      return JobStatus.Skipped;
    }

    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const lease = setInterval(() => {
      void this.takeoutRepository
        .takeLease(runId, token)
        .then((held) => {
          if (held) {
            return;
          }

          // another worker took over this run; stop promptly instead of racing the new owner
          clearInterval(lease);
          controller.abort();
        })
        .catch(() => {});
    }, LEASE_RENEW_MS);
    let inflight: Promise<void> | null = null;
    const progress = setInterval(() => {
      if (inflight) {
        return;
      }
      inflight = this.tickProgress(runId, controller)
        .catch(() => {})
        .finally(() => {
          inflight = null;
        });
    }, PROGRESS_MS);
    // stop the ticker before the final counters are written, so a late tick cannot overwrite them
    const stopProgress = async () => {
      clearInterval(progress);
      await inflight;
    };

    try {
      if (!run.startedAt) {
        await this.takeoutRepository.updateRun(runId, { startedAt: new Date() });
      }

      await this.phaseScanning(runId, run.exportId, token, controller.signal);
      if (await this.cancelled(runId)) {
        await stopProgress();
        await this.finishCancel(runId);
        return JobStatus.Skipped;
      }

      await this.phasePlanning(runId);
      if (await this.cancelled(runId)) {
        await stopProgress();
        await this.finishCancel(runId);
        return JobStatus.Skipped;
      }

      await this.phaseImporting(runId, controller.signal);
      if (await this.cancelled(runId)) {
        await stopProgress();
        await this.finishCancel(runId);
        return JobStatus.Skipped;
      }

      await stopProgress();
      await this.phaseFinishing(runId);
      return JobStatus.Success;
    } catch (error: any) {
      await stopProgress();
      if (controller.signal.aborted) {
        if (await this.cancelled(runId)) {
          await this.finishCancel(runId);
        }
        return JobStatus.Skipped;
      }
      this.logger.error(`Takeout run ${runId} failed: ${error?.message ?? error}`);
      await this.takeoutRepository
        .updateRun(runId, {
          status: TakeoutRunStatus.Failed,
          error: String(error?.message ?? error),
          finishedAt: new Date(),
        })
        .catch(() => {});
      await this.emitRun(runId);
      return JobStatus.Failed;
    } finally {
      clearInterval(lease);
      clearInterval(progress);
      this.controllers.delete(runId);
      this.albumCache.delete(runId);
    }
  }

  private async cancelled(runId: string) {
    const run = await this.takeoutRepository.getRun(runId);
    return !run || run.status === TakeoutRunStatus.Cancelling || run.status === TakeoutRunStatus.Cancelled;
  }

  // ---------- phase: scanning ----------

  private async phaseScanning(runId: string, exportId: string, token: string, signal: AbortSignal) {
    await this.takeoutRepository.updateRun(runId, { status: TakeoutRunStatus.Scanning });
    await this.emitRun(runId);

    const folder = await this.takeoutRepository.getFolder((await this.takeoutRepository.getRun(runId))!.userId);
    const parts = await this.takeoutRepository.getPartsByExport(exportId);
    for (const part of parts) {
      if (part.isIndex || !folder) {
        continue;
      }
      // Loop the part through claim/scan until it reaches a terminal state. A scan job that
      // died mid-scan can be reset from 'scanning' back to 'pending' (syncUserFolder's stale
      // rule); waiting alone would leave it unscanned and silently drop its entries.
      let current: typeof part | null | undefined = part;
      for (let attempt = 0; attempt < 4 && current; attempt++) {
        if (current.scanStatus === TakeoutScanStatus.Scanning) {
          await this.waitForScan(current.id);
          current = await this.takeoutRepository.getPart(current.id);
          continue;
        }
        if (current.scanStatus !== TakeoutScanStatus.Pending) {
          break;
        }
        const claimed = await this.takeoutRepository.claimPart(current.id, token);
        if (!claimed) {
          current = await this.takeoutRepository.getPart(current.id);
          continue;
        }
        await this.scanClaimedPart(claimed, folder.folderName, token, signal);
        current = await this.takeoutRepository.getPart(current.id);
      }
    }
  }

  private async scanClaimedPart(claimed: any, folderName: string, token: string, signal: AbortSignal) {
    const part = claimed as any;
    const filePath = join(StorageCore.getMediaLocation(), TAKEOUT_ROOT_FOLDER, folderName, part.fileName);
    const result = await performPartScan(this.takeoutRepository, claimed, filePath, token, null, signal);
    switch (result.status) {
      case 'scanned': {
        await this.takeoutRepository.updatePart(part.id, {
          scanStatus: TakeoutScanStatus.Scanned,
          scannedSize: result.scannedSize,
          scannedMtime: result.scannedMtime,
          entryCount: result.entryCount,
          scanOwner: null,
        });

        break;
      }
      case 'error': {
        await this.takeoutRepository.updatePart(part.id, {
          scanStatus: TakeoutScanStatus.Error,
          scanError: result.error ?? 'scan failed',
          scanOwner: null,
        });

        break;
      }
      case 'missing': {
        await this.takeoutRepository.updatePart(part.id, { scanStatus: TakeoutScanStatus.Missing, scanOwner: null });

        break;
      }
      // No default
    }
  }

  private async waitForScan(partId: string) {
    for (let i = 0; i < 360; i++) {
      const part = await this.takeoutRepository.getPart(partId);
      if (!part || part.scanStatus !== TakeoutScanStatus.Scanning) {
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // ---------- phase: planning ----------

  private async phasePlanning(runId: string) {
    const run = await this.takeoutRepository.getRun(runId);
    if (!run) {
      return;
    }
    if ((await this.takeoutRepository.countRunFiles(runId)) > 0) {
      // already planned (resume or restart): the plan is frozen, go straight back to importing
      await this.takeoutRepository.updateRun(runId, { status: TakeoutRunStatus.Importing });
      await this.emitRun(runId);
      return;
    }
    await this.takeoutRepository.updateRun(runId, { status: TakeoutRunStatus.Planning });
    await this.emitRun(runId);

    const settings = mergeRunSettings(run.settings);
    const catalogInputs: CatalogInput[] = [];
    for await (const row of this.takeoutRepository.streamEntriesForExport(run.exportId)) {
      catalogInputs.push({
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
      });
    }

    const catalog = await buildCatalog(catalogInputs, { banned: DEFAULT_BANNED_PATTERNS });
    const plan = await planImport(catalog, settings as any, { rotationProbe: sampleRotationProbe(catalog) });

    const rows = await this.buildRunFileRows(run, plan);
    const bytesTotal = rows
      .filter((r) => r.action === TakeoutRunFileAction.Upload && r.status === TakeoutRunFileStatus.Planned)
      .reduce((s, r) => s + Number(r.size), 0);
    const writeParts = new Set(
      rows
        .filter((r) => r.status === TakeoutRunFileStatus.Planned && r.action === TakeoutRunFileAction.Upload)
        .map((r) => r.partName),
    );
    const partSizes = await this.takeoutRepository.getPartsByExport(run.exportId);
    const archiveBytesTotal = partSizes
      .filter((p) => writeParts.has(p.fileName))
      .reduce((s, p) => s + Number(p.size), 0);

    await this.ensureFreeSpace(run, bytesTotal);
    await this.takeoutRepository.insertRunFiles(rows);
    await this.takeoutRepository.updateRun(runId, {
      status: TakeoutRunStatus.Importing,
      bytesTotal,
      archiveBytesTotal,
    });
    await this.emitRun(runId);
  }

  /** Map the frozen plan into takeout_run_file rows, applying the server pre-check (2.6 step 4). */
  private async buildRunFileRows(run: any, plan: ImportPlan) {
    const groupOfKey = new Map<
      number,
      { index: number; order: number; kind: string; isCover: boolean; links: number[] }
    >();
    for (const group of plan.groups) {
      for (const [order, key] of group.members.entries()) {
        groupOfKey.set(key, {
          index: group.index,
          order,
          kind: group.kind,
          isCover: order === group.coverIndex,
          links: group.links,
        });
      }
    }

    // section 11 D1: index the rotate-only pairs the library reported (PlannedFile.key === array index === row.seq).
    // The original carries `rotateOriginal`/`rotateAngle`/`rotateCopySeqs`; each dropped copy carries `rotateCopyOf`.
    // phaseRotateFaces consumes them to rotate the original, re-detect faces, reconcile the copy's named people, and
    // only then drop the copy.
    const copiesByOriginal = new Map<number, Array<{ copyKey: number; angle: number }>>();
    const originalOfCopy = new Map<number, number>();
    for (const pair of plan.rotatePairs ?? []) {
      const list = copiesByOriginal.get(pair.originalKey) ?? [];
      list.push({ copyKey: pair.copyKey, angle: pair.angle });
      copiesByOriginal.set(pair.originalKey, list);
      originalOfCopy.set(pair.copyKey, pair.originalKey);
    }

    // server checksum pre-check
    const uploadFiles = plan.files.filter((f) => f.action === 'upload' && f.checksum);
    const checksums = uploadFiles.map((f) => f.checksum!) as Buffer[];
    const serverByHex = new Map<string, { id: string; deletedAt: Date | null }>();
    for (let i = 0; i < checksums.length; i += 500) {
      const batch = checksums.slice(i, i + 500);
      const hits = await this.takeoutRepository.getUploadAssetsByChecksums(run.userId, batch);
      for (const hit of hits) {
        serverByHex.set(hit.checksum.toString('hex'), { id: hit.id, deletedAt: hit.deletedAt });
      }
    }

    // deleted-reimport pre-check: with mode 'skip' a file whose checksum matches a permanently
    // deleted asset is reported as previouslyDeletedSkipped and never re-imported (2.6 step 4)
    const preferences = getPreferences(await this.userRepository.getMetadata(run.userId));
    const deletedByHex = new Set<string>();
    if (preferences.deletedReimport.mode === DeletedReimportMode.Skip) {
      for (let i = 0; i < checksums.length; i += 500) {
        const batch = checksums.slice(i, i + 500);
        const hits = await this.assetDeletedChecksumRepository.getByChecksums(run.userId, batch);
        for (const hit of hits) {
          deletedByHex.add(hit.checksum.toString('hex'));
        }
      }
    }

    // name + time pre-check (DEV 5): a non-edited upload whose on-disk name and capture time match a
    // pre-existing server asset is a server twin. same size -> serverDuplicate; local bigger -> upload
    // keeping the smaller server asset (larger version pair); local smaller -> betterOnServer.
    const planChecksums = new Set(plan.files.map((f) => f.checksum?.toString('hex')).filter((h): h is string => !!h));
    const nameNeeded = new Set(
      plan.files.filter((f) => f.action === 'upload' && !f.isEditedCopy).map((f) => nfcBase(f.onDiskName)),
    );
    const nameCandidates = new Map<string, Array<{ id: string; at: Date | null; size: number }>>();
    if (nameNeeded.size > 0) {
      for await (const cand of this.takeoutRepository.streamAssetsForNameMatch(run.userId, new Date(run.createdAt))) {
        const key = nfcBase(cand.originalFileName ?? '');
        if (!nameNeeded.has(key)) {
          continue;
        }
        const hex = cand.checksum?.toString('hex');
        if (hex && planChecksums.has(hex)) {
          continue; // an exact twin is already handled by the checksum pre-check
        }
        if (cand.fileSizeInByte === null || cand.fileSizeInByte === undefined) {
          continue;
        }
        const list = nameCandidates.get(key) ?? [];
        list.push({ id: cand.id, at: cand.at ? new Date(cand.at) : null, size: Number(cand.fileSizeInByte) });
        nameCandidates.set(key, list);
      }
    }

    const seenChecksum = new Map<string, number>(); // hex -> seq of first plan row
    const rows: any[] = [];
    let seq = 0;
    for (const file of plan.files) {
      const g = groupOfKey.get(file.key);
      // section 11 D1 pairing carried on the row's plan (seq === file.key, so the copy seqs are the copy keys).
      const rotateCopies = copiesByOriginal.get(file.key);
      const rotatePlan: Record<string, unknown> | null =
        rotateCopies && rotateCopies.length > 0
          ? {
              rotateOriginal: true,
              rotateAngle: rotateCopies[0].angle,
              rotateCopySeqs: rotateCopies.map((c) => c.copyKey),
            }
          : originalOfCopy.has(file.key)
            ? { rotateCopyOf: originalOfCopy.get(file.key) }
            : null;
      const hex = file.checksum?.toString('hex');
      let action: string = file.action;
      let status: TakeoutRunFileStatus = TakeoutRunFileStatus.Skipped;
      let reason: string | null = file.reason;
      let assetId: string | null = null;
      let smallerAssetId: string | null = null;
      let dependsOnSeq: number | null = null;

      if (file.action === 'upload') {
        if (hex && serverByHex.has(hex)) {
          const hit = serverByHex.get(hex)!;
          action = TakeoutRunFileAction.ServerDuplicate;
          status = TakeoutRunFileStatus.Planned;
          assetId = hit.id;
          reason = hit.deletedAt ? 'already on the server (in trash)' : 'already on the server';
        } else if (hex && seenChecksum.has(hex)) {
          action = TakeoutRunFileAction.AlreadyProcessed;
          status = TakeoutRunFileStatus.Planned;
          dependsOnSeq = seenChecksum.get(hex)!;
        } else if (hex && deletedByHex.has(hex)) {
          action = TakeoutRunFileAction.PreviouslyDeletedSkipped;
          status = TakeoutRunFileStatus.Skipped;
          reason = 'previously deleted (skipped)';
        } else {
          const match = file.isEditedCopy ? null : nameTimeMatch(file, nameCandidates);
          if (match?.kind === 'serverDuplicate') {
            action = TakeoutRunFileAction.ServerDuplicate;
            status = TakeoutRunFileStatus.Planned;
            assetId = match.assetId;
            reason = 'a file with the same name and time is already on the server';
          } else if (match?.kind === 'betterOnServer') {
            action = TakeoutRunFileAction.BetterOnServer;
            status = TakeoutRunFileStatus.Planned;
            assetId = match.assetId;
            reason = 'the server already has a larger version';
          } else {
            action = TakeoutRunFileAction.Upload;
            status = TakeoutRunFileStatus.Planned;
            if (hex) {
              seenChecksum.set(hex, seq);
            }
            if (match?.kind === 'largerLocal') {
              smallerAssetId = match.assetId;
              reason = 'server had a smaller version';
            }
          }
        }
      }

      rows.push({
        runId: run.id,
        seq,
        takeoutPath: file.takeoutPath,
        partName: file.partName,
        size: file.size,
        mtime: file.mtime,
        checksum: file.checksum,
        fileKind: file.fileKind,
        jsonPath: file.jsonPath,
        matcher: file.matcher,
        originalFileName: file.originalFileName,
        groupIndex: g?.index ?? null,
        groupOrder: g?.order ?? null,
        groupKind: g?.kind ?? null,
        isCover: g?.isCover ?? false,
        action,
        status,
        reason,
        assetId,
        smallerAssetId,
        plan: buildRowPlan(file, g, rotatePlan),
        dependsOnSeq,
        rotation: file.rotation ?? 0,
        captureDate: file.data?.captureDate ? new Date(file.data.captureDate) : null,
      });
      seq++;
    }
    return rows;
  }

  // ---------- phase: importing ----------

  private async phaseImporting(runId: string, signal: AbortSignal) {
    const run = await this.takeoutRepository.getRun(runId);
    if (!run) {
      return;
    }
    const settings = mergeRunSettings(run.settings);
    const folder = await this.takeoutRepository.getFolder(run.userId);
    const rows = await this.takeoutRepository.getRunFilesForImport(runId);

    // quota: read the user's cap and usage once, keep a running total of bytes written this run
    const quotaUser = await this.userRepository.get(run.userId, {} as any).catch(() => null);
    const quotaLimit = quotaUser?.quotaSizeInBytes ?? null;
    const quotaBase = Number(quotaUser?.quotaUsageInBytes ?? 0);
    let quotaWritten = 0;

    // resume repair
    for (const row of rows) {
      if (row.status === TakeoutRunFileStatus.Planned && row.targetPath) {
        await unlink(row.targetPath).catch(() => {});
      } else if (row.status === TakeoutRunFileStatus.Written && row.targetPath) {
        const ok = await this.verifyWritten(row.targetPath, row.checksum, Number(row.size));
        if (!ok) {
          await unlink(row.targetPath).catch(() => {});
          await this.takeoutRepository.updateRunFile(row.id, { status: TakeoutRunFileStatus.Planned });
          row.status = TakeoutRunFileStatus.Planned;
        }
      }
    }

    const byGroup = new Map<number, any[]>();
    for (const row of rows) {
      if (row.groupIndex === null) {
        continue;
      }
      const list = byGroup.get(row.groupIndex) ?? [];
      list.push(row);
      byGroup.set(row.groupIndex, list);
    }

    const needWrite = rows.filter(
      (r) => r.action === TakeoutRunFileAction.Upload && r.status === TakeoutRunFileStatus.Planned,
    );
    const wantByPart = new Map<string, Map<string, any>>();
    for (const row of needWrite) {
      const part = row.partName ?? '';
      const map = wantByPart.get(part) ?? new Map();
      map.set(row.takeoutPath, row);
      wantByPart.set(part, map);
    }

    // process groups already fully ready (server duplicates, resume)
    for (const [groupIndex, members] of byGroup) {
      if (members.every((m) => this.rowReady(m, rows))) {
        await this.processGroup(run, settings, groupIndex, byGroup, rows);
      }
    }

    // walk the parts that have pending writes
    const allExportParts = await this.takeoutRepository.getPartsByExport(run.exportId);
    const parts = allExportParts
      .filter((p) => !p.isIndex && wantByPart.has(p.fileName))
      .sort((a, b) => (a.segment ?? -1) - (b.segment ?? -1) || a.partNumber - b.partNumber);

    for (const part of parts) {
      if (signal.aborted) {
        return;
      }
      const wanted = wantByPart.get(part.fileName)!;
      if (!folder) {
        continue;
      }
      const remaining = rows
        .filter((r) => r.action === TakeoutRunFileAction.Upload && r.status === TakeoutRunFileStatus.Planned)
        .reduce((s, r) => s + Number(r.size), 0);
      await this.ensureFreeSpace(run, remaining);
      const filePath = join(StorageCore.getMediaLocation(), TAKEOUT_ROOT_FOLDER, folder.folderName, part.fileName);
      const kind = part.kind === 'zip' ? 'zip' : 'tgz';

      await walkArchive(
        filePath,
        kind as any,
        async (entry: any, openStream: () => Promise<NodeJS.ReadableStream>) => {
          const row = wanted.get(entry.path);
          if (!row) {
            return;
          }
          if (quotaLimit !== null && quotaBase + quotaWritten + Number(row.size) > quotaLimit) {
            await this.takeoutRepository.updateRunFile(row.id, {
              status: TakeoutRunFileStatus.Error,
              error: 'quota exceeded',
            });
            row.status = TakeoutRunFileStatus.Error;
            throw new RunFailure('quota exceeded');
          }
          const uuid = row.newAssetId ?? randomUUID();
          const ext = extname(row.originalFileName ?? entry.path).toLowerCase();
          const targetPath = StorageCore.getNestedPath(StorageFolder.Upload, run.userId, `${uuid}${ext}`);
          await this.takeoutRepository.updateRunFile(row.id, { newAssetId: uuid, targetPath });
          row.newAssetId = uuid;
          row.targetPath = targetPath;

          await mkdir(join(targetPath, '..'), { recursive: true });
          const tap = hashTap();
          try {
            const source = await openStream();
            await pipeline(source, tap.stream, createWriteStream(targetPath, { highWaterMark: 4 * 1024 * 1024 }));
          } catch (error: any) {
            await unlink(targetPath).catch(() => {});
            if (error?.code === 'ENOSPC') {
              await this.takeoutRepository.updateRunFile(row.id, {
                status: TakeoutRunFileStatus.Error,
                error: 'disk full',
              });
              throw new RunFailure('Not enough free space');
            }
            await this.takeoutRepository.updateRunFile(row.id, {
              status: TakeoutRunFileStatus.Error,
              error: String(error?.message ?? error),
            });
            row.status = TakeoutRunFileStatus.Error;
            this.evaluateErrorPolicy(settings, rows, true);
            return;
          }
          const { checksum, size } = tap.result();
          if (row.checksum && !checksum.equals(row.checksum)) {
            await unlink(targetPath).catch(() => {});
            await this.takeoutRepository.updateRunFile(row.id, {
              status: TakeoutRunFileStatus.Error,
              error: 'archive changed since the scan',
            });
            row.status = TakeoutRunFileStatus.Error;
            this.evaluateErrorPolicy(settings, rows, true);
            return;
          }
          quotaWritten += size;
          await this.takeoutRepository.updateRunFile(row.id, { status: TakeoutRunFileStatus.Written });
          row.status = TakeoutRunFileStatus.Written;
          await this.takeoutRepository.updateRun(runId, {
            bytesDone: sqlIncrement('bytesDone', size),
            currentFile: row.takeoutPath,
          } as any);

          if (row.groupIndex !== null) {
            const members = byGroup.get(row.groupIndex)!;
            if (members.every((m) => this.rowReady(m, rows))) {
              await this.processGroup(run, settings, row.groupIndex, byGroup, rows);
            }
          }
        },
        {
          onBytes: (n) => void this.takeoutRepository.updateRun(runId, { archiveBytesRead: n } as any).catch(() => {}),
          signal,
        },
      );
    }

    // any group not yet processed: process with ready members only
    for (const [groupIndex, members] of byGroup) {
      if (members.some((m) => m.status === TakeoutRunFileStatus.Done)) {
        continue;
      }
      await this.processGroup(run, settings, groupIndex, byGroup, rows);
    }

    // section 11 D1: rotate each rotate-only-pair original, re-detect its faces and reconcile the dropped copy's
    // named people, then drop the copy. Runs after uploads so the originals exist.
    if (settings.applyRotation) {
      await this.phaseRotateFaces(run, settings, rows);
    }
  }

  // ---------- section 11 D1: rotate-only face preservation ----------

  /**
   * For every rotate-only-pair original the planner reported, run the D1 sequence in order (spec 11): (1) apply the
   * rotation edit to the original so it is upright, (2) queue + await face detection on the now-upright original,
   * (3) reconcile the named people that belonged to the dropped copy onto the original, and only THEN (4) drop the
   * copy. The copy is never uploaded, so "drop" is finalising its already-dropped row; it is done last so the
   * original always has the re-detected faces and reconciled people before the copy is discarded.
   */
  private async phaseRotateFaces(run: any, settings: any, rows: any[]) {
    const bySeq = new Map<number, any>(rows.map((r) => [r.seq, r]));
    for (const original of rows) {
      const plan = (original.plan ?? {}) as any;
      if (!plan.rotateOriginal || !original.assetId) {
        continue;
      }
      if (original.status !== TakeoutRunFileStatus.Created && original.status !== TakeoutRunFileStatus.Done) {
        continue;
      }
      const angle = Number(plan.rotateAngle ?? original.rotation ?? 0);
      const copySeqs: number[] = plan.rotateCopySeqs ?? [];
      const copyRows = copySeqs.map((s) => bySeq.get(s)).filter((r): r is any => !!r);
      try {
        // (1) rotate the original upright. Ensure its EXIF dimensions exist first (rotation needs them); a synchronous
        // metadata run is idempotent and lets the edit apply here rather than via the async hook.
        if (angle !== 0) {
          await this.jobRepository.run({
            name: JobName.AssetExtractMetadata,
            data: { id: original.assetId, source: 'upload' },
          });
          const state = await this.applyRotationNow(original.assetId, angle);
          await this.takeoutRepository.updateRunFile(original.id, { rotationState: state });
          original.rotationState = state;
        }

        // (2) queue + await face detection on the now-upright original (the repo's detect path yields correct
        // face positions natively).
        await this.jobRepository.run({
          name: JobName.AssetDetectFaces,
          data: { id: original.assetId, source: 'upload' },
        });

        // (3) reconcile the named people from the dropped copy (and the original's own People/* tags) onto the
        // original, so people are not lost when the copy is discarded.
        const people = this.rotatePairPeople(original, copyRows);
        await this.reconcileRotatePeople(run, original.assetId, people);

        // (4) drop the copy: mark each dropped copy row done, now that the original has the faces + people.
        for (const copy of copyRows) {
          await this.takeoutRepository.updateRunFile(copy.id, { status: TakeoutRunFileStatus.Done });
          copy.status = TakeoutRunFileStatus.Done;
        }
      } catch (error: any) {
        this.logger.warn(
          `Takeout rotate-only face reconcile failed for ${original.assetId}: ${error?.message ?? error}`,
        );
      }
    }
  }

  /** The distinct People/* names carried by the dropped copies and the original's own plan (section 11 D1 step 3). */
  private rotatePairPeople(original: any, copyRows: any[]): string[] {
    const names = new Set<string>();
    const collect = (row: any) => {
      for (const tag of ((row?.plan as any)?.tags ?? []) as string[]) {
        if (!(typeof tag === 'string' && tag.startsWith('People/'))) {
          continue;
        }

        const name = tag.slice('People/'.length).trim();
        if (name !== '') {
          names.add(name);
        }
      }
    };
    collect(original);
    for (const copy of copyRows) {
      collect(copy);
    }
    return [...names];
  }

  /** Ensure the original asset carries the People/* tags of the dropped copy (idempotent). */
  private async reconcileRotatePeople(run: any, assetId: string, people: string[]) {
    if (people.length === 0) {
      return;
    }
    const leaves = await upsertTags(this.tagRepository, {
      userId: run.userId,
      tags: people.map((name) => `People/${name}`),
    });
    if (leaves.length > 0) {
      await this.tagRepository.upsertAssetIds(leaves.map((t) => ({ tagId: t.id, assetId })));
      await this.eventRepository.emit('AssetTag', { assetId } as any);
    }
  }

  private rowReady(row: any, allRows: any[]): boolean {
    if ([TakeoutRunFileStatus.Written, TakeoutRunFileStatus.Created, TakeoutRunFileStatus.Done].includes(row.status)) {
      return true;
    }
    if (row.action === TakeoutRunFileAction.ServerDuplicate || row.action === TakeoutRunFileAction.BetterOnServer) {
      return true;
    }
    if (row.action === TakeoutRunFileAction.AlreadyProcessed && row.dependsOnSeq !== null) {
      const dep = allRows.find((r) => r.seq === row.dependsOnSeq);
      return dep ? [TakeoutRunFileStatus.Created, TakeoutRunFileStatus.Done].includes(dep.status) : false;
    }
    return false;
  }

  private async verifyWritten(path: string, checksum: Buffer | null, size: number) {
    const info = await stat(path).catch(() => null);
    if (!info || Number(info.size) !== size) {
      return false;
    }
    if (!checksum) {
      return true;
    }
    const tap = hashTap();
    const { createReadStream } = await import('node:fs');
    const { Writable } = await import('node:stream');
    await pipeline(createReadStream(path), tap.stream, new Writable({ write: (_c, _e, cb) => cb() }));
    return tap.result().checksum.equals(checksum);
  }

  // ---------- per-group processing (2.7) ----------

  private async processGroup(run: any, settings: any, groupIndex: number, byGroup: Map<number, any[]>, allRows: any[]) {
    const members = [...(byGroup.get(groupIndex) ?? [])].sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0));
    const preError = new Set(members.filter((m) => m.status === TakeoutRunFileStatus.Error).map((m) => m.id));
    for (const row of members) {
      if ([TakeoutRunFileStatus.Done, TakeoutRunFileStatus.Skipped, TakeoutRunFileStatus.Error].includes(row.status)) {
        continue;
      }
      try {
        if (row.action === TakeoutRunFileAction.Upload) {
          await this.processUpload(run, settings, row);
        } else if (
          [
            TakeoutRunFileAction.ServerDuplicate,
            TakeoutRunFileAction.BetterOnServer,
            TakeoutRunFileAction.AlreadyProcessed,
          ].includes(row.action)
        ) {
          await this.processExisting(run, settings, row, allRows);
        }
      } catch (error: any) {
        await this.takeoutRepository.updateRunFile(row.id, {
          status: TakeoutRunFileStatus.Error,
          error: String(error?.message ?? error),
        });
        row.status = TakeoutRunFileStatus.Error;
      }
    }
    await this.stackGroup(run, members, allRows);
    const groupHadError = members.some((m) => m.status === TakeoutRunFileStatus.Error && !preError.has(m.id));
    this.evaluateErrorPolicy(settings, allRows, groupHadError);
  }

  /**
   * Apply the onErrors / stopAfterErrors policy (2.6). `stop` halts the run as failed after the
   * first group that produced an errored row; `continue` with stopAfterErrors=N halts once the
   * run's total error count reaches N. Both are resumable through handleRun's failure path.
   */
  private evaluateErrorPolicy(settings: any, allRows: any[], justErrored: boolean) {
    if (settings.onErrors === TakeoutOnErrors.Stop) {
      if (justErrored) {
        throw new RunFailure('stopped after an error');
      }
      return;
    }
    const limit = Number(settings.stopAfterErrors ?? 0);
    if (limit > 0) {
      const errors = allRows.filter((r) => r.status === TakeoutRunFileStatus.Error).length;
      if (errors >= limit) {
        throw new RunFailure('stopped after reaching the error limit');
      }
    }
  }

  private async ensureFreeSpace(run: any, remainingBytes: number) {
    if (run.importAnyway) {
      return;
    }
    const folder = await this.takeoutRepository.getFolder(run.userId);
    const path = folder
      ? join(StorageCore.getMediaLocation(), TAKEOUT_ROOT_FOLDER, folder.folderName)
      : join(StorageCore.getMediaLocation(), TAKEOUT_ROOT_FOLDER);
    const need = remainingBytes * 1.15 + 5 * 2 ** 30;
    const usage = await this.storageRepository.checkDiskUsage(path).catch(() => null);
    if (usage && usage.available < need) {
      throw new RunFailure('Not enough free space');
    }
  }

  private async processUpload(run: any, settings: any, row: any) {
    const plan = (row.plan ?? {}) as any;
    const uuid = row.newAssetId as string;
    const targetPath = row.targetPath as string;
    const captureDate: Date | null = row.captureDate ?? null;
    const originalFileName = row.originalFileName ?? row.takeoutPath.split('/').pop();

    const fallbacks: string[] = [...(row.fallbacks ?? [])];
    if (!captureDate) {
      fallbacks.push('noGoogleDate');
    }

    // Section 13 capture-time rule ("Google unless 100% sure"). Read the file's EXIF once and let the pure library
    // decide the moment, the zone (null = no zone evidence) and the Immich sidecar/API mechanics.
    const exif = (await this.metadataRepository.readTags(targetPath).catch(() => ({}) as ImmichTags)) as ImmichTags;
    const capture = resolveCaptureTime({
      googleInstant: captureDate,
      exif: deriveCaptureExif(exif),
      names: [originalFileName, row.takeoutPath.split('/').pop()],
    });
    // No zone evidence: display in the user home zone (flagged zoneAssumed); the moment itself stays Google's.
    const zone = capture.zone ?? (effectiveInstantFor(capture, captureDate) ? settings.homeTimeZone : null);
    const zoneSource = capture.zoneSource;
    // The capture instant the algorithm chose (may differ from Google's for a phone that carries its own offset).
    const effectiveInstant: Date | null = capture.instant ?? captureDate;
    for (const flag of capture.flags) {
      if (!fallbacks.includes(flag)) {
        fallbacks.push(flag);
      }
    }

    // adopt an existing asset on resume, else create
    let [asset] = await this.assetRepository.getByIds([uuid]);
    if (!asset) {
      const entryMtime: Date | null = row.mtime ?? null;
      const created = effectiveInstant ?? entryMtime ?? new Date();
      const modified = entryMtime ?? new Date();
      if (!effectiveInstant && !entryMtime && !fallbacks.includes('noDate')) {
        fallbacks.push('noDate');
      }
      try {
        asset = await this.assetRepository.create({
          id: uuid,
          ownerId: run.userId,
          libraryId: null,
          checksum: row.checksum,
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          originalPath: targetPath,
          originalFileName,
          fileCreatedAt: created,
          fileModifiedAt: modified,
          localDateTime: effectiveInstant ? wallTimeAsUtc(effectiveInstant, zone ?? 'UTC') : created,
          type: mimeTypes.assetType(targetPath),
          isFavorite: !!plan.favorited,
          visibility: plan.archived ? AssetVisibility.Archive : AssetVisibility.Timeline,
        } as any);
      } catch (error: any) {
        const existingId = await this.assetRepository.getUploadAssetIdByChecksum(run.userId, row.checksum);
        if (existingId === uuid) {
          const byIds = await this.assetRepository.getByIds([uuid]);
          asset = byIds[0];
        } else if (existingId) {
          await unlink(targetPath).catch(() => {});
          await this.takeoutRepository.updateRunFile(row.id, {
            action: TakeoutRunFileAction.ServerDuplicate,
            assetId: existingId,
            status: TakeoutRunFileStatus.Done,
          });
          row.action = TakeoutRunFileAction.ServerDuplicate;
          row.assetId = existingId;
          row.status = TakeoutRunFileStatus.Done;
          return;
        } else {
          throw error;
        }
      }
    }

    await this.takeoutRepository.updateRunFile(row.id, {
      status: TakeoutRunFileStatus.Created,
      assetId: asset.id,
      zone,
      zoneSource: zoneSource as TakeoutZoneSource | null,
      fallbacks,
    });
    row.status = TakeoutRunFileStatus.Created;
    row.assetId = asset.id;

    const originalPath = asset.originalPath;
    const entryMtime: Date | null = row.mtime ?? null;
    await utimes(originalPath, new Date(), entryMtime ?? new Date()).catch(() => {});
    await this.assetRepository.upsertExif({
      exif: { assetId: asset.id, fileSizeInByte: Number(row.size) },
      lockedPropertiesBehavior: 'override',
    } as any);

    // Every exif-side write for a new asset happens BEFORE its single metadata extraction is queued, and nothing
    // queues a SidecarWrite for it. Extraction drops the file's values of every lockable column (date, zone, GPS,
    // description, tags) when asset_exif changes while it runs (the updateId guard of fix/tag-sidecar-race), so a
    // concurrent tag sync or SidecarWrite unlock left dates and GPS empty. The sidecar written here holds exactly
    // what the AssetTag / PUT-date SidecarWrite jobs would have written, and the locks are released the same way.
    //
    // section 12 IMMICH MECHANICS: only supply a field the file lacks. A sidecar DateTimeOriginal overrides the
    // file's own date+zone, so it is written only when putDate is true (a section 13 rule chose the moment); a phone
    // file that already carries the right offset (PHONE rule 1, putDate=false) is never clobbered. GPS is written
    // only when the file itself lacks GPS (writing GPS to XMP forces the zone).
    const assetTags = await this.tagNewAsset(run, settings, asset.id, plan);
    const locked: LockableProperty[] = assetTags.length > 0 ? ['tags'] : [];
    let sidecarDate: string | undefined;
    // The capture date is stored WITH an explicit offset as locked exif (the same values PUT dateTimeOriginal
    // stores), so the UI shows it at once and the extraction keeps it. putDate is false when the file already
    // carries its own date+zone (rule 1) or when there is no instant. The offset is sent only when a section 13
    // rule supplied one; otherwise the moment is stored with no zone.
    if (capture.putDate && effectiveInstant) {
      const putZone = capture.putOffsetZone ?? zone;
      const dateTimeOriginal = putZone ? sidecarDateString(effectiveInstant, putZone) : effectiveInstant.toISOString();
      const timeZone = putZone ? (extractTimeZone(dateTimeOriginal)?.name ?? null) : null;
      await this.assetRepository.upsertExif({
        exif: updateLockedColumns({ assetId: asset.id, dateTimeOriginal, timeZone }),
        lockedPropertiesBehavior: 'append',
      } as any);
      locked.push('dateTimeOriginal', 'timeZone');
      // exactly what SidecarWrite writes for a locked date (handleSidecarWrite: mergeTimeZone(...).toISO())
      sidecarDate = mergeTimeZone(effectiveInstant.toISOString(), timeZone)?.toISO() ?? undefined;
    }

    const wantsGps = capture.writeGpsToSidecar && hasLocation(plan.latitude ?? 0, plan.longitude ?? 0);
    const sidecarTags: Record<string, unknown> = {};
    if (wantsGps) {
      sidecarTags.GPSLatitude = plan.latitude;
      sidecarTags.GPSLongitude = plan.longitude;
    }
    if (plan.description) {
      sidecarTags.Description = plan.description;
      sidecarTags.ImageDescription = plan.description;
    }
    if (sidecarDate) {
      sidecarTags.DateTimeOriginal = sidecarDate;
    }
    if (assetTags.length > 0) {
      sidecarTags.TagsList = assetTags;
    }
    if (Object.keys(sidecarTags).length > 0) {
      const sidecarPath = `${originalPath}.xmp`;
      const written = await this.metadataRepository.writeTags(sidecarPath, sidecarTags as any);
      if (written) {
        await this.assetRepository.upsertFile({ assetId: asset.id, type: AssetFileType.Sidecar, path: sidecarPath });
        if (locked.length > 0) {
          await this.assetRepository.unlockProperties(asset.id, locked);
        }
      } else if (locked.length > 0) {
        // fall back to the regular path: SidecarWrite retries the file, unlocks and re-extracts when a date is locked
        await this.jobRepository.queue({ name: JobName.SidecarWrite, data: { id: asset.id } });
      }
    }

    await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: { id: asset.id, source: 'upload' } });

    if (!(row.fallbacks ?? []).includes('quotaCounted')) {
      await this.eventRepository.emit('AssetCreate', {
        asset: asset as any,
        file: {
          uuid: asset.id,
          checksum: row.checksum,
          originalPath,
          originalName: originalFileName,
          size: Number(row.size),
        },
      } as any);
      fallbacks.push('quotaCounted');
      await this.takeoutRepository.updateRunFile(row.id, { fallbacks });
    }

    await this.addAlbums(run, settings, row, asset.id, plan);
    await this.saveGoogleMetadata(settings, asset.id, plan, false);

    // rotation. A rotate-only-pair original (section 11 D1) is NOT queued for the async rotation hook here: the D1
    // pass (phaseRotateFaces) owns its rotation so it can order rotate -> re-detect faces -> reconcile people ->
    // drop the copy. Every other rotated upload defers to the AssetMetadataExtracted hook as before.
    if ((row.rotation ?? 0) !== 0 && settings.applyRotation && !plan.rotateOriginal) {
      await this.takeoutRepository.updateRunFile(row.id, { rotationState: TakeoutRotationState.Pending });
      row.rotationState = TakeoutRotationState.Pending;
    }

    // larger version pair
    if (row.smallerAssetId) {
      await this.takeoutRepository.insertLargerVersion({
        userId: run.userId,
        runId: run.id,
        largerAssetId: asset.id,
        smallerAssetId: row.smallerAssetId,
      });
    }

    await this.finishRow(row);
  }

  private async processExisting(run: any, settings: any, row: any, allRows: any[]) {
    const plan = (row.plan ?? {}) as any;
    let assetId: string | null = row.assetId;
    if (row.action === TakeoutRunFileAction.AlreadyProcessed && row.dependsOnSeq !== null) {
      const dep = allRows.find((r) => r.seq === row.dependsOnSeq);
      assetId = dep?.assetId ?? null;
    }
    if (!assetId) {
      await this.takeoutRepository.updateRunFile(row.id, {
        status: TakeoutRunFileStatus.Error,
        error: 'server asset removed since planning',
      });
      row.status = TakeoutRunFileStatus.Error;
      return;
    }
    const [asset] = await this.assetRepository.getByIds([assetId]);
    if (!asset) {
      await this.takeoutRepository.updateRunFile(row.id, {
        status: TakeoutRunFileStatus.Error,
        error: 'server asset removed since planning',
      });
      row.status = TakeoutRunFileStatus.Error;
      return;
    }
    row.assetId = assetId;

    // a file may have been written before the duplicate appeared: unlink it
    if (row.targetPath) {
      await unlink(row.targetPath).catch(() => {});
    }

    await this.addAlbums(run, settings, row, assetId, plan);
    if (settings.tagServerDuplicates) {
      await this.addTags(run, settings, row, assetId, plan, true);
    }
    const alreadyHasMeta = row.action === TakeoutRunFileAction.AlreadyProcessed;
    await this.saveGoogleMetadata(settings, assetId, plan, alreadyHasMeta);

    if (row.action !== TakeoutRunFileAction.BetterOnServer && (row.rotation ?? 0) !== 0 && settings.applyRotation) {
      const withEdits = await this.assetRepository
        .getById(assetId, { exifInfo: true, edits: true } as any)
        .catch(() => null);
      if (withEdits && (withEdits as any).edits && (withEdits as any).edits.length > 0) {
        await this.takeoutRepository.updateRunFile(row.id, { rotationState: TakeoutRotationState.SkippedHasEdits });
      } else {
        const exif = (withEdits as any)?.exifInfo;
        if (exif?.exifImageWidth && exif.exifImageHeight) {
          await this.applyRotationNow(assetId, row.rotation);
          await this.takeoutRepository.updateRunFile(row.id, { rotationState: TakeoutRotationState.Applied });
        } else {
          await this.takeoutRepository.updateRunFile(row.id, { rotationState: TakeoutRotationState.Pending });
        }
      }
    }

    await this.finishRow(row);
  }

  private async finishRow(row: any) {
    const plan = (row.plan ?? {}) as any;
    const reduced: Record<string, unknown> = { albums: plan.albums ?? [], tags: plan.tags ?? [], links: plan.links };
    // keep the section 11 D1 pairing on the reduced plan so phaseRotateFaces can still act on a finished original.
    if (plan.rotateOriginal) {
      reduced.rotateOriginal = true;
      reduced.rotateAngle = plan.rotateAngle;
      reduced.rotateCopySeqs = plan.rotateCopySeqs;
    }
    if (plan.rotateCopyOf !== undefined) {
      reduced.rotateCopyOf = plan.rotateCopyOf;
    }
    await this.takeoutRepository.updateRunFile(row.id, { status: TakeoutRunFileStatus.Done, plan: reduced });
    row.status = TakeoutRunFileStatus.Done;
    row.plan = reduced;
  }

  /**
   * Section 13 mechanics: apply the capture date through the same locked-exif PUT the interactive API uses
   * (`dateTimeOriginal` + its `timeZone`), then queue the sidecar write. With a zone, the date carries that explicit
   * offset; without one (no zone evidence), the moment is stored with a null time zone (Immich's default display,
   * no invented zone). The date is never written into the pre-extraction sidecar, so a file that already carries
   * its own date+zone keeps them natively.
   */
  private async addAlbums(run: any, settings: any, row: any, assetId: string, plan: any) {
    if (!settings.syncAlbums) {
      return;
    }
    for (const album of plan.albums ?? []) {
      const albumId = await this.resolveAlbum(run, album);
      await this.albumRepository.addAssetIds(albumId, [assetId]).catch(() => {});
    }
  }

  private albumCache = new Map<string, Map<string, string>>();

  private async resolveAlbum(run: any, album: { title: string; description?: string }): Promise<string> {
    let cache = this.albumCache.get(run.id);
    if (!cache) {
      cache = new Map();
      this.albumCache.set(run.id, cache);
    }
    const key = album.title;
    if (cache.has(key)) {
      return cache.get(key)!;
    }
    const owned = await this.albumRepository.getAll(run.userId, { name: album.title }).catch(() => []);
    const existing = (owned as any[])
      .filter((a) => a.albumName === album.title)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
    let albumId: string;
    if (existing) {
      albumId = existing.id;
    } else {
      const created = await this.albumRepository.create(
        { albumName: album.title, description: album.description ?? '' },
        [],
        [{ userId: run.userId, role: AlbumUserRole.Owner }],
        run.userId,
      );
      albumId = created.id;
    }
    cache.set(key, albumId);
    return albumId;
  }

  /**
   * Tag a newly created asset without the AssetTag event (its SidecarWrite would race the metadata extraction). The
   * caller writes the returned values into the pre-extraction sidecar as TagsList and releases the tags lock.
   */
  private async tagNewAsset(run: any, settings: any, assetId: string, plan: any): Promise<string[]> {
    const vars = run.templateVars as { date: string; user: string; start: string };
    const tags = dedupeTags([...(plan.tags ?? []), ...runTags(settings, vars)]);
    if (tags.length === 0) {
      return [];
    }
    const leaves = await upsertTags(this.tagRepository, { userId: run.userId, tags });
    if (leaves.length === 0) {
      return [];
    }
    await this.tagRepository.upsertAssetIds(leaves.map((t) => ({ tagId: t.id, assetId })));
    return leaves.map((t) => t.value);
  }

  private async addTags(run: any, settings: any, row: any, assetId: string, plan: any, _isUpload: boolean) {
    const vars = run.templateVars as { date: string; user: string; start: string };
    const tags = dedupeTags([...(plan.tags ?? []), ...runTags(settings, vars)]);
    if (tags.length === 0) {
      return;
    }
    const leaves = await upsertTags(this.tagRepository, { userId: run.userId, tags });
    if (leaves.length > 0) {
      await this.tagRepository.upsertAssetIds(leaves.map((t) => ({ tagId: t.id, assetId })));
      await this.eventRepository.emit('AssetTag', { assetId } as any);
    }
  }

  private async saveGoogleMetadata(settings: any, assetId: string, plan: any, alreadyProcessed: boolean) {
    if (!settings.googlePhotosFields || !plan.extra || Object.keys(plan.extra).length === 0) {
      return;
    }
    if (alreadyProcessed) {
      // the first file of a duplicate set already wrote its extras: never overwrite them
      const existing = await this.assetRepository.getMetadataByKey(assetId, 'google-photos').catch(() => null);
      if (existing) {
        return;
      }
    }
    await Promise.resolve(
      this.assetRepository.upsertMetadata(assetId, [{ key: 'google-photos', value: plan.extra }]),
    ).catch(() => {});
  }

  private async stackGroup(run: any, members: any[], allRows: any[]) {
    const ids = assembleStackIds(
      members
        .filter((m) => m.status === TakeoutRunFileStatus.Done && m.assetId)
        .sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0))
        .map((m) => ({ assetId: m.assetId, smallerAssetId: m.smallerAssetId })),
      this.linkAssetIds(members, allRows),
    );
    if (ids.length < 2) {
      return;
    }
    try {
      const previousStacks = await this.stackRepository.getForUserEdit({ assetIds: ids });
      const stack = await this.stackRepository.create({ ownerId: run.userId, source: StackSource.Manual } as any, ids, {
        privateMode: true,
        userId: run.userId,
      } as any);
      await this.eventRepository.emit('StackCreate', { stackId: stack.id, userId: run.userId } as any);
      for (const previous of previousStacks) {
        const memberIds = previous.assets.map((a: any) => a.id);
        const assetIds = ids.includes(previous.primaryAssetId)
          ? memberIds
          : memberIds.filter((id: string) => ids.includes(id));
        await this.eventRepository.emit('StackUserEdit', {
          userId: run.userId,
          stackId: previous.id,
          source: previous.source,
          action: StackUserEditAction.Merge,
          assetIds,
          targetStackId: stack.id,
        } as any);
      }
    } catch (error: any) {
      this.logger.warn(`Takeout stack failed: ${error?.message ?? error}`);
    }
  }

  private linkAssetIds(members: any[], allRows: any[]): Array<string | null> {
    const cover = members.find((m) => m.isCover);
    const links: number[] = (cover?.plan as any)?.links ?? [];
    return links.map((seq) => allRows.find((r) => r.seq === seq)?.assetId ?? null);
  }

  // ---------- finding T9/#9: post-import verification ----------

  /**
   * Finding T9/#9 (section 12): the metadata / thumbnail / video-conversion jobs sometimes silently never ran. Verify
   * the post state of every asset this run created and re-queue exactly the jobs that are missing, rather than trusting
   * the queue. Re-queued jobs are idempotent (they no-op when the work is already done), so this is safe to run even
   * while the original jobs may still be in flight.
   */
  private async verifyAndRequeue(rows: any[]) {
    const assetIds = [
      ...new Set(
        rows
          .filter(
            (r) =>
              r.assetId &&
              r.action === TakeoutRunFileAction.Upload &&
              (r.status === TakeoutRunFileStatus.Created || r.status === TakeoutRunFileStatus.Done),
          )
          .map((r) => r.assetId as string),
      ),
    ];
    if (assetIds.length === 0) {
      return;
    }

    const jobs: JobItem[] = [];
    for (let i = 0; i < assetIds.length; i += 500) {
      const batch = assetIds.slice(i, i + 500);
      const states = await this.takeoutRepository.getPostImportState(batch);
      for (const state of states) {
        const id = state.id;
        if (!state.metadataDone) {
          jobs.push({ name: JobName.AssetExtractMetadata, data: { id, source: 'upload' } });
        }
        if (!state.hasThumbhash || !state.hasPreview || !state.hasThumbnail) {
          jobs.push({ name: JobName.AssetGenerateThumbnails, data: { id, source: 'upload' } });
        }
        if (state.type === AssetType.Video && !state.hasEncodedVideo) {
          jobs.push({ name: JobName.AssetEncodeVideo, data: { id } });
        }
      }
    }

    if (jobs.length > 0) {
      await this.jobRepository.queueAll(jobs);
    }
  }

  // ---------- phase: finishing ----------

  private async phaseFinishing(runId: string) {
    await this.takeoutRepository.updateRun(runId, { status: TakeoutRunStatus.Finishing });
    const run = await this.takeoutRepository.getRun(runId);
    if (!run) {
      return;
    }

    // Finding T9/#9: verify each created asset's post-import state and re-queue the jobs that silently did not run,
    // rather than trusting the queue.
    await this.verifyAndRequeue(await this.takeoutRepository.getRunFilesForImport(runId));

    const rows = await this.takeoutRepository.getCounterRows(runId);
    const counters = countersFromRows(rows as any, { total: Number(run.bytesTotal), done: Number(run.bytesDone) });
    await this.takeoutRepository.updateRun(runId, {
      status: TakeoutRunStatus.Completed,
      counters: counters as unknown as object,
      finishedAt: new Date(),
    });

    const uploaded = counters.result.uploaded;
    const dupes = counters.result.serverDuplicates;
    const errors = counters.result.errors;
    await this.notificationRepository
      .create({
        userId: run.userId,
        type: NotificationType.Custom,
        title: `Takeout import finished: ${uploaded} uploaded, ${dupes} duplicates, ${errors} errors`,
        data: { runId } as any,
      } as any)
      .catch(() => {});
    this.websocketRepository.clientSend('on_notification' as any, run.userId, { runId } as any);
    await this.emitRun(runId);
    this.albumCache.delete(runId);
  }

  /** Periodic progress: recompute the counters from the run file rows while importing and push them to the owner. */
  private async tickProgress(runId: string, controller: AbortController) {
    const run = await this.takeoutRepository.getRun(runId);
    if (!run || run.status === TakeoutRunStatus.Cancelling) {
      // the 2 s poll is the fallback when the TakeoutRunCancel server event did not reach this worker
      controller.abort();
      return;
    }
    if (run.status !== TakeoutRunStatus.Importing) {
      return;
    }
    const rows = await this.takeoutRepository.getCounterRows(runId);
    const counters = countersFromRows(rows as any, { total: Number(run.bytesTotal), done: Number(run.bytesDone) });
    await this.takeoutRepository.updateRun(runId, { counters: counters as unknown as object });
    await this.emitRun(runId);
  }

  /**
   * Cancel cleanup run by the job itself (spec 2.6): the same steps as TakeoutService.cleanupCancelledRun, which the
   * cancel endpoint uses for queued or stale runs. Unlink partial and written files, mark those rows skipped, set the
   * run cancelled and emit.
   */
  private async finishCancel(runId: string) {
    const rows = await this.takeoutRepository.getRunFilesWithTargetPath(runId);
    for (const row of rows) {
      if (
        !row.targetPath ||
        (row.status !== TakeoutRunFileStatus.Planned && row.status !== TakeoutRunFileStatus.Written)
      ) {
        continue;
      }
      await unlink(row.targetPath).catch(() => {});
      await this.takeoutRepository.updateRunFile(row.id, { status: TakeoutRunFileStatus.Skipped, reason: 'cancelled' });
    }
    const run = await this.takeoutRepository.getRun(runId);
    if (!run) {
      return;
    }
    const rowsForCounters = await this.takeoutRepository.getCounterRows(runId);
    const counters = countersFromRows(rowsForCounters as any, {
      total: Number(run.bytesTotal),
      done: Number(run.bytesDone),
    });
    await this.takeoutRepository.updateRun(runId, {
      status: TakeoutRunStatus.Cancelled,
      counters: counters as unknown as object,
      finishedAt: new Date(),
      leaseToken: null,
    });
    await this.emitRun(runId);
  }

  private async emitRun(runId: string) {
    const run = await this.takeoutRepository.getRun(runId);
    if (run) {
      const rotationCounts = await this.takeoutRepository.getRotationCounts(runId);
      this.websocketRepository.clientSend('on_takeout_run', run.userId, mapRunForEvent(run, rotationCounts));
    }
  }

  // ---------- rotation hook (2.10) ----------

  @OnEvent({ name: 'AssetMetadataExtracted' })
  async onMetadataExtracted({ assetId }: { assetId: string }) {
    const rows = await this.takeoutRepository.getPendingRotations(assetId);
    if (rows.length === 0) {
      return;
    }
    const angle = rows[0].rotation;
    const state = await this.applyRotationNow(assetId, angle);
    for (const row of rows) {
      await this.takeoutRepository.updateRunFile(row.id, { rotationState: state });
    }
  }

  private async applyRotationNow(assetId: string, angle: number): Promise<TakeoutRotationState> {
    const asset = await this.assetRepository.getById(assetId, { exifInfo: true, edits: true } as any).catch(() => null);
    if (!asset) {
      return TakeoutRotationState.SkippedNotEditable;
    }
    const a = asset as any;
    const path = a.originalPath ?? '';
    const notEditable =
      a.type !== 'IMAGE' ||
      a.livePhotoVideoId ||
      /\.(gif|svg)$/i.test(path) ||
      !a.exifInfo?.exifImageWidth ||
      !a.exifInfo?.exifImageHeight;
    if (notEditable) {
      return TakeoutRotationState.SkippedNotEditable;
    }
    if (a.edits && a.edits.length > 0) {
      return TakeoutRotationState.SkippedHasEdits;
    }
    await this.assetEditRepository.replaceAll(assetId, [
      { action: AssetEditAction.Rotate, parameters: { angle: (360 - angle) % 360 } } as any,
    ]);
    await this.jobRepository.queue({ name: JobName.AssetEditThumbnailGeneration, data: { id: assetId } });
    return TakeoutRotationState.Applied;
  }
}

class RunFailure extends Error {}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') {
      return v.trim();
    }
  }
  return null;
}

// Read an exiftool date value (ExifDateTime object or "YYYY:MM:DD HH:MM:SS" string) as a Date whose UTC calendar
// components equal the value's own wall clock (zone ignored). Used for the file clock and GPSDateTime.
function exifWallClock(value: unknown): Date | null {
  if (!value) {
    return null;
  }
  if (typeof value === 'object') {
    const v = value as {
      year?: number;
      month?: number;
      day?: number;
      hour?: number;
      minute?: number;
      second?: number;
      millisecond?: number;
    };
    if (typeof v.year === 'number') {
      return new Date(
        Date.UTC(
          v.year,
          (v.month ?? 1) - 1,
          v.day ?? 1,
          v.hour ?? 0,
          v.minute ?? 0,
          v.second ?? 0,
          Math.round(v.millisecond ?? 0),
        ),
      );
    }
    return null;
  }
  if (typeof value === 'string') {
    const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value);
    if (m) {
      return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
    }
  }
  return null;
}

// Reduce a full exiftool read to the primitives the section 13 capture-time rule needs. Splitting the exiftool
// `zone`/`zoneSource` into an explicit file offset (kept) vs a GPS-derived zone (ignored: GPS never supplies the
// zone) happens here, at the Nest boundary, so the pure library never interprets exiftool output.
function deriveCaptureExif(raw: ImmichTags): CaptureExifInput {
  const exif = raw as ImmichTags & Record<string, unknown>;
  const make = firstString(exif.Make, exif.AndroidMake, exif.DeviceManufacturer, exif.Device?.Manufacturer);
  const model = firstString(exif.Model, exif.AndroidModel, exif.DeviceModelName, exif.Device?.ModelName);

  const zone = firstString(exif.zone, exif.tz);
  const zoneSource = (firstString(exif.zoneSource, exif.tzSource) ?? '').toLowerCase();
  const gpsDerived = zoneSource.includes('gps') || zoneSource.includes('geolocation');
  let fileOffsetZone: string | null = null;
  const recorded =
    zoneSource.includes('offset') ||
    zoneSource.includes('timezone') ||
    zoneSource.includes('creationdate') ||
    zoneSource.includes('timecreated');
  if (zone && !zoneSource.includes('defaultvideostoutc') && !gpsDerived && recorded) {
    fileOffsetZone = zone;
  }

  const fileHasGps = typeof exif.GPSLatitude === 'number' && typeof exif.GPSLongitude === 'number';
  const fileClock = exifWallClock(
    exif.SubSecDateTimeOriginal ?? exif.DateTimeOriginal ?? exif.CreationDate ?? exif.CreateDate,
  );
  const gpsDateTime = exifWallClock(exif.GPSDateTime);

  return { make, model, fileOffsetZone, fileHasGps, fileClock, gpsDateTime };
}

function nfcBase(name: string | null | undefined): string {
  return basename(name ?? '').normalize('NFC');
}

/**
 * Go's compareDate name+time match (DEV 5). The first candidate in id order whose capture time is
 * within `-5s <= local - server < 5s` decides: equal size is a server duplicate, a bigger local file
 * keeps the smaller server asset as a larger-version pair, a smaller local file is beaten on the server.
 */
function nameTimeMatch(
  file: any,
  candidates: Map<string, Array<{ id: string; at: Date | null; size: number }>>,
): { kind: 'serverDuplicate' | 'largerLocal' | 'betterOnServer'; assetId: string } | null {
  const local: Date | null = file.data?.captureDate ? new Date(file.data.captureDate) : (file.mtime ?? null);
  if (!local) {
    return null;
  }
  const list = candidates.get(nfcBase(file.onDiskName));
  if (!list) {
    return null;
  }
  const localTime = local.getTime();
  const localSize = Number(file.size);
  for (const cand of list) {
    if (!cand.at) {
      continue;
    }
    const diff = localTime - cand.at.getTime();
    if (diff >= -5000 && diff < 5000) {
      if (localSize === cand.size) {
        return { kind: 'serverDuplicate', assetId: cand.id };
      }
      return localSize > cand.size
        ? { kind: 'largerLocal', assetId: cand.id }
        : { kind: 'betterOnServer', assetId: cand.id };
    }
  }
  return null;
}

function mergeRunSettings(settings: any) {
  return settings;
}

/** The takeout_run_file.plan payload: the cover's links, the file's asset data, and any section 11 D1 rotate pairing. */
function buildRowPlan(
  file: any,
  g: { isCover: boolean; links: number[] } | undefined,
  rotatePlan: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const coverLinks = g?.isCover && g.links.length > 0 ? { links: g.links } : null;
  let base: Record<string, unknown> | null = null;
  if (file.data) {
    base = { ...file.data, links: g?.isCover ? g.links : undefined };
  } else if (coverLinks) {
    base = coverLinks;
  }
  if (rotatePlan) {
    return { ...base, ...rotatePlan };
  }
  return base;
}

function sqlIncrement(column: string, amount: number) {
  // Kysely raw increment for a bigint column
  return sql`${sql.ref(column)} + ${amount}`;
}

function mapRunForEvent(run: any, _rotationCounts: Record<string, number>) {
  const counters = (run.counters ?? {}) as any;
  return {
    id: run.id,
    exportId: run.exportId,
    status: run.status,
    importAnyway: run.importAnyway,
    settings: run.settings,
    counters,
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
