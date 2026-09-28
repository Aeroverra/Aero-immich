import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core';
import {
  AssetType,
  JobName,
  StorageFolder,
  TakeoutRunFileAction,
  TakeoutRunFileStatus,
  TakeoutRunStatus,
} from 'src/enum';
import type { AssetRepository } from 'src/repositories/asset.repository';
import type { JobRepository } from 'src/repositories/job.repository';
import type { LoggingRepository } from 'src/repositories/logging.repository';
import type { TakeoutRepository } from 'src/repositories/takeout.repository';
import type { WebsocketRepository } from 'src/repositories/websocket.repository';
import { mapExport, mapRun } from 'src/services/takeout-mappers';
import { normalizeReadStats } from 'src/services/takeout-read';
import {
  ReclaimResult,
  ReclaimRow,
  STAGING_TTL_MS,
  StagingFs,
  StagingStore,
  nodeStagingFs,
  reclaimFile,
  trashStagingDir,
} from 'src/services/takeout-staging';
import { countersFromRows } from 'src/takeout';
import { JobItem } from 'src/types';

// Cleanup paths shared by the run job and the API (single-pass design 5.3, 5.4, 10.1, 10.2).

export const TAKEOUT_ROOT_FOLDER = 'takeouts';

export function takeoutFolderPath(folderName: string): string {
  return join(StorageCore.getMediaLocation(), TAKEOUT_ROOT_FOLDER, folderName);
}

export function uploadUserDir(userId: string): string {
  return StorageCore.getFolderLocation(StorageFolder.Upload, userId);
}

export interface LifecycleDeps {
  takeout: TakeoutRepository;
  asset: Pick<AssetRepository, 'getByIds'>;
  job: Pick<JobRepository, 'queue' | 'queueAll' | 'removeJob'>;
  websocket: Pick<WebsocketRepository, 'clientSend'>;
  logger: Pick<LoggingRepository, 'log' | 'warn' | 'error'>;
  stagingFs?: StagingFs;
}

const RECLAIMABLE = new Set<string>([
  TakeoutRunFileStatus.Planned,
  TakeoutRunFileStatus.Written,
  TakeoutRunFileStatus.Error,
]);

/** The caller rule of reclaim (single-pass design 5.4), one statement per row */
export async function applyReclaim(repo: TakeoutRepository, row: ReclaimRow, result: ReclaimResult): Promise<void> {
  const open = row.status === TakeoutRunFileStatus.Planned || row.status === TakeoutRunFileStatus.Written;
  if (result === 'asset') {
    if (open) {
      // create committed, the status update was lost: processUpload continues on resume, the file is its original
      await repo.updateRunFile(row.id, { status: TakeoutRunFileStatus.Created, assetId: row.newAssetId });
    }
    return;
  }
  await repo.updateRunFile(row.id, {
    targetPath: null,
    ...(open && { status: TakeoutRunFileStatus.Planned }),
  });
  row.targetPath = null;
}

/**
 * Every asset-less target of a run: back to staging when complete ('stage', needs a store), else unlinked. Rows
 * whose asset exists become created.
 */
export async function reclaimRunTargets(
  deps: LifecycleDeps,
  runId: string,
  store: StagingStore | null,
  how: 'stage' | 'unlink',
  options: { includeSkipped?: boolean } = {},
): Promise<{ staged: number; unlinked: number; assets: number }> {
  const counts = { staged: 0, unlinked: 0, assets: 0 };
  const rows = await deps.takeout.getRunFilesWithTarget(runId);
  for (const row of rows) {
    const reclaimable =
      RECLAIMABLE.has(row.status) || (options.includeSkipped === true && row.status === TakeoutRunFileStatus.Skipped);
    if (row.action !== TakeoutRunFileAction.Upload || !reclaimable) {
      continue;
    }
    const reclaimRow: ReclaimRow = {
      id: row.id,
      status: row.status,
      targetPath: row.targetPath,
      newAssetId: row.newAssetId,
      size: row.size,
      checksum: row.checksum,
      entrySeq: row.entrySeq,
    };
    let result: ReclaimResult;
    if (store) {
      result = await store.reclaim(reclaimRow, how);
    } else {
      const [asset] = reclaimRow.newAssetId ? await deps.asset.getByIds([reclaimRow.newAssetId]) : [];
      if (!asset && how === 'stage') {
        // no staging to move a complete file into (share unreachable): leave it, the boot step reclaims it
        continue;
      }
      result = asset ? 'asset' : await reclaimFile(deps.stagingFs ?? nodeStagingFs, reclaimRow, 'unlink', null);
    }
    counts[result === 'asset' ? 'assets' : result === 'staged' ? 'staged' : 'unlinked']++;
    await applyReclaim(deps.takeout, reclaimRow, result);
  }
  return counts;
}

/**
 * Finding T9/#9 (section 12): the metadata / thumbnail / video-conversion jobs sometimes silently never ran. Verify
 * the post state of every asset a run created and re-queue exactly the jobs that are missing. Re-queued jobs are
 * idempotent, so this is safe while the original jobs may still be in flight.
 */
export async function verifyAndRequeue(
  deps: Pick<LifecycleDeps, 'takeout' | 'job'>,
  rows: Array<{ assetId: string | null; action: string; status: string }>,
): Promise<void> {
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
    const states = await deps.takeout.getPostImportState(batch);
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
    await deps.job.queueAll(jobs);
  }
}

export async function openRunStaging(
  deps: LifecycleDeps,
  run: { id: string; userId: string },
  folderName: string,
): Promise<StagingStore> {
  return StagingStore.open(run, takeoutFolderPath(folderName), uploadUserDir(run.userId), {
    repo: deps.takeout,
    assets: deps.asset,
    logger: deps.logger,
    fs: deps.stagingFs,
  });
}

export async function emitRun(deps: LifecycleDeps, runId: string): Promise<void> {
  const run = await deps.takeout.getRun(runId);
  if (run) {
    const rotationCounts = await deps.takeout.getRotationCounts(runId);
    deps.websocket.clientSend('on_takeout_run', run.userId, mapRun(run, rotationCounts));
  }
}

export async function emitExport(deps: LifecycleDeps, exportId: string): Promise<void> {
  const exp = await deps.takeout.getExport(exportId);
  if (!exp) {
    return;
  }
  const parts = await deps.takeout.getPartsByExport(exportId);
  const runs = await deps.takeout.getRunsByExport(exportId);
  deps.websocket.clientSend('on_takeout_export', exp.userId, mapExport(exp, parts, runs[0] ?? null));
}

/** Analysis inputs changed (a run reached a final state, parts changed): analyse again */
export async function queueAnalysis(deps: LifecycleDeps, exportId: string): Promise<void> {
  await deps.takeout.updateExport(exportId, { analysisInputsAt: new Date() });
  await deps.job.removeJob(JobName.TakeoutAnalyzeExport, exportId).catch(() => {});
  await deps.job.queue({ name: JobName.TakeoutAnalyzeExport, data: { exportId } });
}

/**
 * Cancel cleanup, used by the job and by the API for queued or stale runs (single-pass design 10.1): targets are
 * reclaimed into staging, assets created before the cancel get their jobs, planned rows become skipped 'cancelled',
 * parts of the run in 'reading' become 'partial', staging is kept (7 days), then the status check-and-set.
 */
export async function cleanupCancelledRun(
  deps: LifecycleDeps,
  runId: string,
  options: { token: string | null; from: TakeoutRunStatus[]; readStats?: unknown },
): Promise<boolean> {
  const run = await deps.takeout.getRun(runId);
  if (!run || !options.from.includes(run.status)) {
    return false;
  }
  const folder = await deps.takeout.getFolder(run.userId);
  const targets = await deps.takeout.getRunFilesWithTarget(runId);
  const superseded = await deps.takeout.getRunsSupersededBy(runId);
  let store: StagingStore | null = null;
  if (folder && (targets.length > 0 || superseded.length > 0 || run.hasStaging)) {
    try {
      // also performs a pending adoption rename, so the staging of the previous run is not lost
      store = await openRunStaging(deps, run, folder.folderName);
    } catch (error) {
      deps.logger.warn(`Takeout cancel of run ${runId}: staging unavailable: ${String(error)}`);
    }
  }
  await reclaimRunTargets(deps, runId, store, 'stage');
  await verifyAndRequeue(deps, await deps.takeout.getRunFilesForImport(runId));
  await deps.takeout.updateRunFilesByStatus(runId, [TakeoutRunFileStatus.Planned, TakeoutRunFileStatus.Written], {
    status: TakeoutRunFileStatus.Skipped,
    reason: 'cancelled',
  });
  await deps.takeout.updatePartsOfRun(runId);

  const readStats = normalizeReadStats(options.readStats ?? run.readStats);
  if (store) {
    const held = await store.bytesHeld();
    readStats.stagingBytes = held.bytes;
    readStats.stagingExpiresAt = new Date(Date.now() + STAGING_TTL_MS).toISOString();
    readStats.crossDevice ||= store.crossDevice;
  }
  const counters = countersFromRows((await deps.takeout.getCounterRows(runId)) as any, {
    total: Number(run.bytesTotal),
    done: Number(run.bytesDone),
  });
  const ok = await deps.takeout.finishRunCas(runId, options.from, options.token, TakeoutRunStatus.Cancelled, {
    finishedAt: new Date(),
    counters: counters as unknown as object,
    readStats: readStats as unknown as object,
    currentFile: null,
  });
  if (!ok) {
    return false;
  }
  await deps.job.removeJob(JobName.TakeoutRun, `${runId}/${run.attempt}`).catch(() => {});
  await queueAnalysis(deps, run.exportId).catch(() => {});
  await emitRun(deps, runId);
  return true;
}

/**
 * Discard (single-pass design 5.3): the staged files of a failed or cancelled run are removed now. Targets are
 * unlinked (never a file whose asset exists), created assets get their jobs, planned rows become skipped
 * 'cancelled', a failed run becomes cancelled. The directory is renamed to trash and deleted in the background; a
 * failed delete is left to the sweep and never fails the request.
 */
export async function discardRunStaging(deps: LifecycleDeps, runId: string): Promise<boolean> {
  const run = await deps.takeout.getRun(runId);
  if (!run) {
    return false;
  }
  const folder = await deps.takeout.getFolder(run.userId);
  const done = await deps.takeout.withUserSyncLock(run.userId, async () => {
    const fresh = await deps.takeout.getRun(runId);
    if (!fresh || (fresh.status !== TakeoutRunStatus.Failed && fresh.status !== TakeoutRunStatus.Cancelled)) {
      return false;
    }
    await reclaimRunTargets(deps, runId, null, 'unlink');
    await verifyAndRequeue(deps, await deps.takeout.getRunFilesForImport(runId));
    await deps.takeout.updateRunFilesByStatus(runId, [TakeoutRunFileStatus.Planned, TakeoutRunFileStatus.Written], {
      status: TakeoutRunFileStatus.Skipped,
      reason: 'cancelled',
    });
    const readStats = normalizeReadStats(fresh.readStats);
    readStats.stagingBytes = 0;
    readStats.stagingExpiresAt = null;
    if (fresh.status === TakeoutRunStatus.Failed) {
      await deps.takeout.finishRunCas(runId, [TakeoutRunStatus.Failed], null, TakeoutRunStatus.Cancelled, {
        hasStaging: false,
        readStats: readStats as unknown as object,
      });
    } else {
      await deps.takeout.updateRun(runId, { hasStaging: false, readStats: readStats as unknown as object });
    }
    return true;
  });
  if (done && folder) {
    await trashStagingDir(takeoutFolderPath(folder.folderName), runId, deps.stagingFs, deps.logger);
  }
  if (done) {
    await emitRun(deps, runId);
  }
  return done;
}
