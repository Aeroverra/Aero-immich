import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { statfs, utimes } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { TAKEOUT_QUEUE_CONCURRENCY } from 'src/constants';
import { StorageCore } from 'src/cores/storage.core';
import { LockableProperty } from 'src/database';
import { OnEvent, OnJob } from 'src/decorators';
import { AssetEditAction } from 'src/dtos/editing.dto';
import {
  AlbumUserRole,
  AssetFileType,
  AssetVisibility,
  ChecksumAlgorithm,
  ImmichWorker,
  JobName,
  JobStatus,
  NotificationType,
  QueueName,
  StackSource,
  StackUserEditAction,
  StorageFolder,
  TakeoutCatalogStatus,
  TakeoutOnErrors,
  TakeoutRotationState,
  TakeoutRunFileAction,
  TakeoutRunFileStatus,
  TakeoutRunStatus,
  TakeoutZoneSource,
} from 'src/enum';
import { ArgOf } from 'src/repositories/event.repository';
import type { ImmichTags } from 'src/repositories/metadata.repository';
import { TAKEOUT_LEASED_RUN_STATUSES, TAKEOUT_RUNNING_RUN_STATUSES } from 'src/repositories/takeout.repository';
import { BaseService } from 'src/services/base.service';
import { storedAnalysisInput } from 'src/services/takeout-analyze.service';
import { assembleStackIds, dedupeTags, hasLocation } from 'src/services/takeout-asset';
import {
  LifecycleDeps,
  applyReclaim,
  cleanupCancelledRun,
  emitExport,
  emitRun,
  openRunStaging,
  queueAnalysis,
  reclaimRunTargets,
  stopReadingParts,
  takeoutFolderPath,
  verifyAndRequeue,
} from 'src/services/takeout-lifecycle';
import {
  CATALOG_VERSION,
  CancelReason,
  DEFAULT_READ_LIMITS,
  FetchOccurrence,
  FetchRequest,
  LeaseLost,
  LiveReadSettings,
  ProcessResources,
  ReadContext,
  ReadLimits,
  ReadPartRow,
  ReadStatsTracker,
  RecountEntry,
  RunFailure,
  RunParked,
  asRunReason,
  catalogUsable,
  fetchEntries,
  getProcessResources,
  isStableNow,
  keyEqual,
  readPartWithRetry,
  readerPool,
  recountReadStats,
  settleWithin,
  statFingerprint,
  withDeadline,
} from 'src/services/takeout-read';
import { STAGING_TTL_MS, StagingFs, StagingStore, unlinkTarget } from 'src/services/takeout-staging';
import {
  CaptureExifInput,
  CatalogInput,
  DEFAULT_BANNED_PATTERNS,
  FileSourceFs,
  Gate,
  ImportPlan,
  LastReadAnalysis,
  PlannedFile,
  TemplateVars,
  UnreadablePart,
  analyzeExport,
  buildCatalog,
  countersFromRows,
  crossCheckIndex,
  groupEdges,
  hex,
  messageOf,
  newReadMeter,
  orderGroups,
  parseArchiveBrowser,
  pathKey,
  planImport,
  readArchiveEntry,
  readZipDirectory,
  resolveCaptureTime,
  runTags,
  samplePairsToKeep,
  sampleRotationProbe,
  sidecarDateString,
  wallTimeAsUtc,
  withGoogleAccount,
} from 'src/takeout';
import { JobOf } from 'src/types';
import { updateLockedColumns } from 'src/utils/database';
import { extractTimeZone, mergeTimeZone } from 'src/utils/date';
import { DeletedReimportRepositories, checkDeletedReimport, onDeletedReimport } from 'src/utils/deleted-reimport';
import { mimeTypes } from 'src/utils/mime-types';
import { upsertTags } from 'src/utils/tag';

export { RunFailure } from 'src/services/takeout-read';

const LEASE_RENEW_MS = 10_000;
// progress persisted and on_takeout_run emitted every 2 s while the run is live (all phases)
const PROGRESS_MS = 2000;
const STATFS_REFRESH_MS = 10_000;
// the last progress tick gets this long to settle before the final writes; a tick stuck on the database is left
const TICK_SETTLE_CAP_MS = 2000;
// a cancel whose run is held by another live worker is looked at again once that lease could have expired
const LEASE_RETRY_DELAY_MS = 70_000;
// a run paused this long gives its place in the Takeout queue back when every place is paused and jobs wait
const PARK_AFTER_MS = 10 * 60_000;
// a look at the Takeout queue that takes longer is given up (a pause point waits for it)
const QUEUE_LOOK_CAP_MS = 5000;
const TERMINAL_ROW_STATUSES = new Set<string>([
  TakeoutRunFileStatus.Done,
  TakeoutRunFileStatus.Skipped,
  TakeoutRunFileStatus.Error,
]);

// a file the user permanently deleted before (utils/deleted-reimport): the report reason of one that is not imported,
// and the flag of one that is, followed by the mode it was handled with (previouslyDeleted:trash, previouslyDeleted:album)
const PREVIOUSLY_DELETED_REASON = 'previously deleted (skipped)';
const PREVIOUSLY_DELETED_FLAG = 'previouslyDeleted';

const previouslyDeletedFlags = (row: { fallbacks?: string[] | null } | undefined): string[] =>
  (row?.fallbacks ?? []).filter((flag) => flag.startsWith(`${PREVIOUSLY_DELETED_FLAG}:`));

const uploadFirst = (row: { action: string }) => (row.action === TakeoutRunFileAction.Upload ? 0 : 1);

const formatBytes = (bytes: number): string => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

/** Everything one job attempt of a run holds (single-pass design 6.3, 6.9) */
interface Attempt {
  runId: string;
  run: any;
  token: string;
  controller: AbortController;
  signal: AbortSignal;
  folderName: string;
  userFolder: string;
  staging: StagingStore | null;
  ctx: ReadContext | null;
  stats: ReadStatsTracker;
  parts: ReadPartRow[];
  settings: any;
  status: TakeoutRunStatus;
  lastStatfs: number;
  lastExportEmit: number;
  /** the index file list, read at most once per attempt (sampling set and planning) */
  indexFiles: Promise<string[] | null> | null;
  /** closed while the run is paused: reads wait at their next read, the other steps at their next safe point */
  pause: Gate;
  /** order of the status reads that decide the pause: a read that started before the one applied last is stale */
  statusReads: number;
  appliedStatusRead: number;
}

@Injectable()
export class TakeoutRunService extends BaseService {
  private controllers = new Map<string, AbortController>();
  /** the attempts this worker runs, for pause, resume and changed read settings */
  private attempts = new Map<string, Attempt>();
  /** the read settings of the system config (null until the config is loaded: the read limits apply) */
  private liveSettings: LiveReadSettings | null = null;
  /** how often progress is written and the stall watchdog and the pause fallback look (tests shorten it) */
  progressMs = PROGRESS_MS;
  /** how long every place of the Takeout queue may be held by paused runs while jobs wait for one (parkIfBlocking) */
  parkAfterMs = PARK_AFTER_MS;
  /** the jobs the Takeout queue runs at once on this worker (QueueService) */
  queueConcurrency = TAKEOUT_QUEUE_CONCURRENCY;
  private parking = false;
  /** overridable in tests: small limits, own process resources, fault-injecting file systems */
  readLimits: ReadLimits = DEFAULT_READ_LIMITS;
  processResources: ProcessResources | null = null;
  archiveFs?: FileSourceFs;
  stagingFs?: StagingFs;
  /** free bytes of the staging disk (statfs); overridable in tests */
  diskAvailable?: (path: string) => Promise<number>;

  private get deletedReimportRepositories(): DeletedReimportRepositories {
    return {
      album: this.albumRepository,
      asset: this.assetRepository,
      assetDeletedChecksum: this.assetDeletedChecksumRepository,
      event: this.eventRepository,
      user: this.userRepository,
    };
  }

  private get lifecycle(): LifecycleDeps {
    return {
      takeout: this.takeoutRepository,
      asset: this.assetRepository,
      job: this.jobRepository,
      websocket: this.websocketRepository,
      logger: this.logger,
      stagingFs: this.stagingFs,
    };
  }

  // sent by the API worker with serverSend, so it must listen for server events (spec 2.6 Cancellation)
  @OnEvent({ name: 'TakeoutRunCancel', server: true })
  onCancel({ runId }: { runId: string }) {
    this.controllers.get(runId)?.abort(new CancelReason());
  }

  /** Pause or resume from the API: look at the status now (the 2 s tick is the fallback) */
  @OnEvent({ name: 'TakeoutRunPause', server: true })
  async onPauseChange({ runId }: { runId: string }) {
    const a = this.attempts.get(runId);
    if (!a) {
      return;
    }
    const { run, read } = await this.readStatus(a);
    if (run) {
      this.syncPause(a, run, read);
    }
  }

  /** The run row, numbered: the pause follows the newest read only (an event and a tick can overlap) */
  private async readStatus(a: Attempt) {
    const read = ++a.statusReads;
    const run = await this.takeoutRepository.getRun(a.runId);
    return { run, read };
  }

  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  onConfigInit({ newConfig }: ArgOf<'ConfigInit'>) {
    this.applyReadSettings(newConfig.takeout);
  }

  /** The admin changed the read settings: running runs resize their readers and take the new limits */
  @OnEvent({ name: 'ConfigUpdate', server: true })
  onConfigUpdate({ newConfig }: ArgOf<'ConfigUpdate'>) {
    this.applyReadSettings(newConfig.takeout);
  }

  private applyReadSettings(takeout: LiveReadSettings | undefined) {
    if (!takeout) {
      return;
    }
    const settings: LiveReadSettings = {
      readers: Math.max(1, Math.min(this.readLimits.maxReaders, Math.floor(takeout.readers))),
      readaheadDepth: Math.max(1, Math.floor(takeout.readaheadDepth)),
      throttleMBps: takeout.throttleMBps && takeout.throttleMBps > 0 ? takeout.throttleMBps : null,
    };
    const previous = this.liveSettings;
    this.liveSettings = settings;
    this.resources().throttle.setRate(settings.throttleMBps);
    for (const a of this.attempts.values()) {
      a.ctx?.applySettings(settings);
    }
    if (
      previous &&
      (previous.readers !== settings.readers ||
        previous.readaheadDepth !== settings.readaheadDepth ||
        previous.throttleMBps !== settings.throttleMBps)
    ) {
      this.logger.log(
        `Takeout read settings: ${settings.readers} readers, readahead ${settings.readaheadDepth}, ` +
          (settings.throttleMBps ? `limit ${settings.throttleMBps} MB/s` : 'no read limit'),
      );
    }
  }

  /** The settings a new attempt starts with: the system config, else the read limits (tests, before the config) */
  private currentReadSettings(): LiveReadSettings {
    return (
      this.liveSettings ?? {
        readers: this.readLimits.readers,
        readaheadDepth: this.readLimits.readaheadDepth,
        throttleMBps: this.readLimits.throttleMBps,
      }
    );
  }

  /** Follow the status the API set: paused closes the gate of the attempt, a running status opens it */
  private syncPause(a: Attempt, run: { status: TakeoutRunStatus }, read: number) {
    if (read < a.appliedStatusRead) {
      // read before a newer status was applied: it would undo a pause or a resume that came in between
      return;
    }
    a.appliedStatusRead = read;
    if (run.status === TakeoutRunStatus.Paused) {
      this.pauseAttempt(a);
    } else if (TAKEOUT_RUNNING_RUN_STATUSES.includes(run.status)) {
      this.resumeAttempt(a);
    }
  }

  private pauseAttempt(a: Attempt) {
    if (!a.pause.close()) {
      return;
    }
    this.logger.log(`Takeout run ${a.runId} paused`);
    a.stats.stats.etaSeconds = null;
    // what was read so far is kept now: a restart while paused loses nothing of it
    void this.persistProgress(a)
      .then(() => emitRun(this.lifecycle, a.runId))
      .catch(() => {});
  }

  private resumeAttempt(a: Attempt) {
    if (a.pause.isOpen) {
      return;
    }
    const pausedMs = a.pause.open();
    a.stats.resumeAfter(pausedMs);
    this.logger.log(`Takeout run ${a.runId} resumed after ${Math.round(pausedMs / 1000)} s`);
  }

  /**
   * A safe point outside the reads (between phases, groups, rotated originals): while the run is paused the attempt
   * waits here, holding its lease; a cancel or a lost lease ends the wait. With `checkAbort: false` (finishing, which a
   * cancel does not stop) a cancel only ends the wait: finishing continues and the run completes (finishRunCas takes a
   * cancelling run). The wait looks at the status itself too, so a resume whose event got lost is seen also when the
   * progress tick is stopped (finishing).
   */
  private async pausePoint(a: Attempt, { checkAbort = true }: { checkAbort?: boolean } = {}) {
    if (checkAbort) {
      this.throwIfAborted(a);
    }
    if (a.pause.isOpen || this.cancelledWhileFinishing(a, checkAbort)) {
      return;
    }
    await this.persistProgress(a).catch(() => {});
    // one wait on the gate for as long as it stays closed, shared by the polls: a wait per poll would leave a waiter
    // on the gate and a listener on the signal every poll for as long as the pause lasts
    let resumed: Promise<void> | null = null;
    while (!a.pause.isOpen) {
      if (!resumed) {
        const wait: Promise<void> = a.pause.wait(a.signal).finally(() => {
          if (resumed === wait) {
            resumed = null;
          }
        });
        wait.catch(() => {});
        resumed = wait;
      }
      let timer: NodeJS.Timeout | undefined;
      const poll = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.progressMs);
      });
      try {
        await Promise.race([resumed, poll]);
      } catch (error) {
        // the signal aborted: a cancel, a lost lease or a park
        if (this.cancelledWhileFinishing(a, checkAbort)) {
          return;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (a.pause.isOpen) {
        break;
      }
      await this.parkIfBlocking(a);
      const { run, read } = await this.readStatus(a);
      if (!run || !TAKEOUT_LEASED_RUN_STATUSES.includes(run.status)) {
        const reason = run?.status === TakeoutRunStatus.Cancelling ? new CancelReason() : new LeaseLost();
        a.controller.abort(reason);
        if (this.cancelledWhileFinishing(a, checkAbort)) {
          return;
        }
        throw reason;
      }
      this.syncPause(a, run, read);
    }
  }

  /** finishing (a pause point with `checkAbort: false`) is not stopped by a cancel: the run completes */
  private cancelledWhileFinishing(a: Attempt, checkAbort: boolean): boolean {
    return !checkAbort && a.signal.aborted && a.signal.reason instanceof CancelReason;
  }

  /**
   * Every attempt holds a place in the Takeout queue, a paused one too, so that it can continue its open reads (a tgz
   * part is never read twice). When every place of this worker is held by an attempt paused for longer than
   * `parkAfterMs` and other Takeout jobs wait for a place (another user's import, a scan, an analysis), the attempt
   * paused longest gives its place back (parkRun): its job ends like after a restart while paused, and Resume queues
   * the run again (a zip part continues at its next entry, a tgz part is read again from byte 0).
   */
  private async parkIfBlocking(a: Attempt): Promise<void> {
    if (this.parking || a.pause.isOpen || a.signal.aborted) {
      return;
    }
    const paused = this.attempts
      .values()
      .filter((other) => !other.pause.isOpen && !other.signal.aborted)
      .toArray();
    if (paused.length < this.queueConcurrency) {
      return;
    }
    const since = (other: Attempt) => other.pause.closedAt ?? Infinity;
    const longest = paused.toSorted((x, y) => since(x) - since(y))[0];
    if (longest !== a || Date.now() - since(a) < this.parkAfterMs) {
      return;
    }
    this.parking = true;
    try {
      const { waiting } = await withDeadline(
        this.jobRepository.getJobCounts(QueueName.Takeout),
        QUEUE_LOOK_CAP_MS,
        () => new Error('no answer'),
      );
      if (waiting > 0 && !a.pause.isOpen && !a.signal.aborted) {
        this.logger.log(
          `Takeout run ${a.runId}: paused for ${Math.round((Date.now() - since(a)) / 60_000)} min while ${waiting} ` +
            `Takeout job(s) wait for a place in the queue; it gives its place back, Resume queues it again`,
        );
        a.controller.abort(new RunParked());
      }
    } catch (error) {
      this.logger.warn(`Takeout run ${a.runId}: could not look at the Takeout queue: ${messageOf(error)}`);
    } finally {
      this.parking = false;
    }
  }

  /**
   * A check-and-set of the job that found the run paused (the pause came between the last safe point and the
   * write): wait until it is resumed and try again. False when the run is not paused under this job's lease.
   */
  private async waitIfPaused(a: Attempt): Promise<boolean> {
    const { run: current, read } = await this.readStatus(a);
    if (current?.status !== TakeoutRunStatus.Paused || current.leaseToken !== a.token) {
      return false;
    }
    this.syncPause(a, current, read);
    await this.pausePoint(a);
    return true;
  }

  @OnJob({ name: JobName.TakeoutRun, queue: QueueName.Takeout })
  async handleRun({ runId, attempt }: JobOf<JobName.TakeoutRun>): Promise<JobStatus> {
    const run = await this.takeoutRepository.getRun(runId);
    if (!run) {
      return JobStatus.Skipped;
    }
    if (run.status === TakeoutRunStatus.Cancelling) {
      // re-queued at boot, or queued before the cancel: finish as cancelled, unless a live worker holds the run and
      // cleans up itself (the claim refuses a live lease)
      const done = await cleanupCancelledRun(this.lifecycle, runId, {
        token: null,
        from: [TakeoutRunStatus.Cancelling],
      });
      const current = done ? null : await this.takeoutRepository.getRun(runId);
      if (current?.status === TakeoutRunStatus.Cancelling) {
        // if that worker dies, its lease expires and this job finishes the cancel
        await this.jobRepository.queue({
          name: JobName.TakeoutRun,
          data: { runId, attempt: attempt + 1, delay: LEASE_RETRY_DELAY_MS },
        });
      }
      return JobStatus.Skipped;
    }
    if (!TAKEOUT_RUNNING_RUN_STATUSES.includes(run.status)) {
      // a stale job for a failed, cancelled or completed run: never run a phase again (I10)
      this.logger.log(`Takeout run ${runId} is ${run.status}: nothing to do`);
      return JobStatus.Skipped;
    }
    const token = randomUUID();
    if (!(await this.takeoutRepository.takeLease(runId, token))) {
      const fresh = await this.takeoutRepository.getRun(runId);
      if (fresh && TAKEOUT_RUNNING_RUN_STATUSES.includes(fresh.status)) {
        // another live worker holds the lease: look again later, the lease expires if that worker died
        await this.jobRepository.queue({
          name: JobName.TakeoutRun,
          data: { runId, attempt: attempt + 1, delay: LEASE_RETRY_DELAY_MS },
        });
      }
      return JobStatus.Skipped;
    }

    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const pause = new Gate();
    const a: Attempt = {
      runId,
      run,
      token,
      controller,
      signal: controller.signal,
      folderName: '',
      userFolder: '',
      staging: null,
      ctx: null,
      stats: new ReadStatsTracker(run.readStats),
      parts: [],
      settings: run.settings,
      status: run.status,
      lastStatfs: 0,
      lastExportEmit: 0,
      indexFiles: null,
      pause,
      statusReads: 0,
      appliedStatusRead: 0,
    };
    this.attempts.set(runId, a);

    let renewing: Promise<void> | null = null;
    const lease = setInterval(() => {
      const renewal: Promise<void> = this.takeoutRepository
        .takeLease(runId, token)
        .then(async (held) => {
          if (held) {
            return;
          }
          // the lease CAS only renews running and paused runs: a cancel request is not a lost lease
          const current = await this.takeoutRepository.getRun(runId);
          controller.abort(current?.status === TakeoutRunStatus.Cancelling ? new CancelReason() : new LeaseLost());
        })
        .catch(() => {})
        .finally(() => {
          if (renewing === renewal) {
            renewing = null;
          }
        });
      renewing = renewal;
    }, LEASE_RENEW_MS);
    // before the job releases a paused run's lease: a renewal that ran after the release would take it again
    const stopLease = async () => {
      clearInterval(lease);
      await settleWithin(renewing, TICK_SETTLE_CAP_MS);
    };
    let inflight: Promise<void> | null = null;
    const progress = setInterval(() => {
      // the stall watchdog (I9) runs on every tick, even while an earlier tick still waits for the database
      a.ctx?.checkStall();
      if (inflight) {
        return;
      }
      inflight = this.tickProgress(a)
        .catch((error: unknown) => this.logger.warn(`Takeout run ${runId} progress: ${messageOf(error)}`))
        .finally(() => {
          inflight = null;
        });
    }, this.progressMs);
    // stop the ticker before the final writes, so a late tick cannot overwrite them; a tick that does not settle
    // within the cap cannot either: its writes need a running status and the lease. The lease keeps its heartbeat
    // until the job ends (finally), so a slow finish or failure path is never taken over as a dead worker's run.
    const stopTimers = async () => {
      clearInterval(progress);
      await settleWithin(inflight, TICK_SETTLE_CAP_MS);
    };

    try {
      if (!run.startedAt) {
        await this.takeoutRepository.updateRun(runId, { startedAt: new Date() });
      }
      const folder = await this.takeoutRepository.getFolder(run.userId);
      if (!folder) {
        throw new RunFailure('The takeout folder of the user is missing');
      }
      a.folderName = folder.folderName;
      a.userFolder = takeoutFolderPath(folder.folderName);
      a.staging = await openRunStaging(this.lifecycle, run, folder.folderName);
      a.stats.stats.crossDevice ||= a.staging.crossDevice;
      // adoption (10.4): a target the previous run left behind (normally none) moves into this run's staging
      for (const old of await this.takeoutRepository.getRunsSupersededBy(runId)) {
        await reclaimRunTargets(this.lifecycle, old.id, a.staging, 'stage');
      }
      a.ctx = new ReadContext({
        run,
        deps: { repo: this.takeoutRepository, logger: this.logger, fs: this.archiveFs },
        limits: this.readLimits,
        resources: this.resources(),
        staging: a.staging,
        stats: a.stats,
        partPath: (fileName) => `${a.userFolder}/${fileName}`,
        signal: controller.signal,
        pause: a.pause,
      });
      a.ctx.applySettings(this.currentReadSettings());
      const allParts = await this.takeoutRepository.getPartsByExport(run.exportId);
      a.parts = allParts.filter((p) => !p.isIndex) as any;

      // a run whose plan rows exist skips reading and planning on every resume (R3-12)
      const planned = (await this.takeoutRepository.countRunFiles(runId)) > 0;
      if (!planned) {
        await this.phaseReading(a);
        await this.phasePlanning(a);
      }
      await this.phaseRepair(a);
      await this.phaseFetching(a);
      await this.phaseImporting(a);
      this.throwIfAborted(a);
      await stopTimers();
      await this.phaseFinishing(a);
      return JobStatus.Success;
    } catch (error: unknown) {
      await stopTimers();
      const reason = this.abortReason(a, error);
      const current = await this.takeoutRepository.getRun(runId);
      if (reason instanceof LeaseLost && current?.status !== TakeoutRunStatus.Cancelling) {
        this.logger.log(`Takeout run ${runId}: another worker owns the run now`);
        return JobStatus.Skipped;
      }
      if (reason instanceof CancelReason || current?.status === TakeoutRunStatus.Cancelling) {
        // with the lease this job holds; refused (and left to that worker) when another one took the run meanwhile
        await cleanupCancelledRun(this.lifecycle, runId, {
          token: a.token,
          from: [TakeoutRunStatus.Cancelling, ...TAKEOUT_LEASED_RUN_STATUSES],
          readStats: this.snapshotStats(a),
        });
        return JobStatus.Skipped;
      }
      if (reason instanceof RunParked) {
        await stopLease();
        await this.parkRun(a);
        return JobStatus.Skipped;
      }
      await this.failRun(a, reason);
      return JobStatus.Failed;
    } finally {
      clearInterval(lease);
      clearInterval(progress);
      a.ctx?.dispose();
      this.controllers.delete(runId);
      this.attempts.delete(runId);
      this.albumCache.delete(runId);
    }
  }

  private resources(): ProcessResources {
    return this.processResources ?? getProcessResources();
  }

  private abortReason(a: Attempt, error: unknown): Error {
    if (a.signal.aborted) {
      return a.signal.reason as Error;
    }
    if (a.ctx?.readAbort.signal.aborted) {
      return asRunReason(a.ctx.readAbort.signal.reason);
    }
    return asRunReason(error);
  }

  private throwIfAborted(a: Attempt) {
    if (a.signal.aborted) {
      throw a.signal.reason;
    }
  }

  /**
   * Every status change is a check-and-set on (id, lease, running status); a lost one aborts the attempt (I10). A
   * paused run changes no phase: the attempt waits until it is resumed, then moves on.
   */
  private async setStatus(a: Attempt, status: TakeoutRunStatus, patch: Record<string, unknown> = {}) {
    for (;;) {
      await this.pausePoint(a);
      const ok = await this.takeoutRepository.setRunStatusCas(a.runId, a.token, status, patch);
      if (ok) {
        break;
      }
      if (await this.waitIfPaused(a)) {
        continue;
      }
      const current = await this.takeoutRepository.getRun(a.runId);
      const reason = current?.status === TakeoutRunStatus.Cancelling ? new CancelReason() : new LeaseLost();
      a.controller.abort(reason);
      throw reason;
    }
    a.status = status;
    await emitRun(this.lifecycle, a.runId);
  }

  // ---------- phase: reading (single-pass design 6.4) ----------

  private async phaseReading(a: Attempt) {
    await this.setStatus(a, TakeoutRunStatus.Reading);
    const ctx = a.ctx!;
    const limits = this.readLimits;
    const todo: ReadPartRow[] = [];
    for (const part of a.parts) {
      const ps = a.stats.part(part);
      const st = await statFingerprint(ctx.partPath(part.fileName), limits);
      if (!st) {
        // what folder sync would do; its report row is written by planning
        if (!part.isMissing) {
          await this.takeoutRepository.markPartMissing(part.id);
        }
        part.isMissing = true;
        part.catalogStatus = TakeoutCatalogStatus.None;
        ctx.missingThisAttempt.add(part.id);
        a.stats.finish(ps, 'missing');
        continue;
      }
      if (part.isMissing) {
        await this.takeoutRepository.updatePart(part.id, { isMissing: false });
        part.isMissing = false;
      }
      if (catalogUsable(part, st)) {
        ps.status = part.lastReadRunId === a.runId && ps.passes > 0 ? 'read' : 'cached';
        ps.position = ps.size;
        continue;
      }
      if (part.catalogStatus === TakeoutCatalogStatus.Error && keyEqual(part, st)) {
        // sticky until the file changes
        ps.status = 'error';
        ps.error = part.catalogError;
        ps.position = ps.size;
        continue;
      }
      if (!isStableNow(st, limits)) {
        throw new RunFailure(`${part.fileName} is still being copied`);
      }
      ps.status = 'pending';
      todo.push(part);
    }
    if (Number(a.run.archiveBytesTotal ?? 0) === 0) {
      a.run.archiveBytesTotal = todo.reduce((sum, part) => sum + Number(part.size), 0);
    }
    // largest first: no small part is left alone at the end
    todo.sort(
      (x, y) => Number(y.size) - Number(x.size) || (x.segment ?? -1) - (y.segment ?? -1) || x.partNumber - y.partNumber,
    );
    await this.persistProgress(a);
    if (todo.length === 0) {
      return;
    }

    const user = await this.userRepository.get(a.run.userId, {} as any).catch(() => null);
    await ctx.prepareReading({
      quotaLimit: user?.quotaSizeInBytes ?? null,
      quotaUsage: Number(user?.quotaUsageInBytes ?? 0),
      statfs: () => this.availableBytes(a),
    });
    ctx.sampleSet = await this.buildSampleSet(a);
    ctx.partsToRead = todo.length;
    a.stats.stats.readers = Math.min(ctx.readers, todo.length);
    a.stats.stats.readahead = ctx.readaheadDepth;
    // the reader count follows the admin setting while the parts are read
    await readerPool(
      ctx,
      todo,
      () => Math.min(ctx.readers, todo.length),
      (part, token) => this.readOnePart(a, part, token),
    );
    if (a.staging!.fatal) {
      throw new RunFailure(messageOf(a.staging!.fatal));
    }
    await this.persistProgress(a);
  }

  private async readOnePart(a: Attempt, part: ReadPartRow, token: { detached: boolean }) {
    this.emitExportThrottled(a, true);
    await readPartWithRetry(a.ctx!, part, token);
    this.emitExportThrottled(a, true);
  }

  private async availableBytes(a: Attempt): Promise<number> {
    const path = a.staging?.dir ?? a.userFolder;
    if (this.diskAvailable) {
      return this.diskAvailable(path);
    }
    const stats = await statfs(path);
    return Number(stats.bavail) * Number(stats.bsize);
  }

  /** statfs awaited by a phase: a share that does not answer fails the run like a stalled read (I9) */
  private availableBytesWithin(a: Attempt): Promise<number> {
    const minutes = Math.round(this.readLimits.readStallMs / 60_000);
    return withDeadline(
      this.availableBytes(a),
      this.readLimits.readStallMs,
      () => new RunFailure(`The staging folder did not answer for ${minutes} min (the share does not answer)`),
    );
  }

  /**
   * The sampling set (single-pass design 6.6, fix F4): export-wide. All zip: the central-directory names of the
   * parts to read plus the catalogued paths; else the index file list; else every decodable image.
   */
  private async buildSampleSet(a: Attempt): Promise<Set<string> | 'all'> {
    const ctx = a.ctx!;
    const present = a.parts.filter((p) => !p.isMissing);
    if (present.length > 0 && present.every((p) => p.kind === 'zip')) {
      const names: string[] = await this.takeoutRepository.getCataloguedMediaPaths(a.run.exportId, CATALOG_VERSION);
      for (const part of present) {
        if (part.catalogStatus === TakeoutCatalogStatus.Complete && part.catalogVersion === CATALOG_VERSION) {
          continue;
        }
        const meter = newReadMeter();
        const unwatch = ctx.watch(part.fileName, meter);
        try {
          const directory = await readZipDirectory(ctx.partPath(part.fileName), {
            signal: ctx.readAbort.signal,
            source: { ...ctx.sourceOptions(), memory: null },
            meter,
          });
          a.stats.stats.directoryBytesRead += directory.bytesRead;
          for (const entry of directory.entries) {
            if (!entry.isDirectory) {
              names.push(entry.name);
            }
          }
        } catch (error) {
          if (ctx.readAbort.signal.aborted) {
            throw ctx.readAbort.signal.reason ?? error;
          }
          // the reader reports an unreadable central directory
        } finally {
          unwatch();
        }
      }
      return new Set([...samplePairsToKeep(names)].map((path) => pathKey(path)));
    }
    const indexFiles = await this.indexFiles(a);
    if (indexFiles) {
      return new Set([...samplePairsToKeep(indexFiles)].map((path) => pathKey(path)));
    }
    return 'all';
  }

  /** The index file list: the analysis keeps it; else the index archive is read, once per attempt */
  private indexFiles(a: Attempt): Promise<string[] | null> {
    a.indexFiles ??= this.loadIndexFiles(a);
    return a.indexFiles;
  }

  private async loadIndexFiles(a: Attempt): Promise<string[] | null> {
    const exp = await this.takeoutRepository.getExport(a.run.exportId);
    const stored = (exp?.analysis ?? {}) as { indexFiles?: unknown };
    if (Array.isArray(stored.indexFiles)) {
      return stored.indexFiles as string[];
    }
    if (!exp?.indexFileName) {
      return null;
    }
    const ctx = a.ctx!;
    const meter = newReadMeter();
    const unwatch = ctx.watch(exp.indexFileName, meter);
    try {
      const html = await readArchiveEntry(
        `${a.userFolder}/${exp.indexFileName}`,
        'tgz',
        'Takeout/archive_browser.html',
        64 * 1024 * 1024,
        { signal: ctx.readAbort.signal, source: ctx.sourceOptions(), meter },
      );
      return html ? parseArchiveBrowser(html.toString('utf8')).files : null;
    } catch (error) {
      if (ctx.readAbort.signal.aborted) {
        throw ctx.readAbort.signal.reason ?? error;
      }
      return null;
    } finally {
      unwatch();
    }
  }

  // ---------- phase: planning (single-pass design 7) ----------

  private async phasePlanning(a: Attempt) {
    await this.setStatus(a, TakeoutRunStatus.Planning);
    const run = a.run;
    const exportId = run.exportId;
    const settings = mergeRunSettings(run.settings);

    // samples: prune to the keep set, then backfill pairs that have none (a part added after the others were read)
    const keep = samplePairsToKeep(await this.takeoutRepository.getMediaEntryPaths(exportId));
    await this.takeoutRepository.pruneSamples(exportId, [...keep]);
    await this.sampleBackfill(a, keep);

    const entryRefs: Array<{ partName: string; seq: number; readError: string | null }> = [];
    const catalogInputs: CatalogInput[] = [];
    const catalogKeys = new Set<string>();
    // the committed rows of the parts this run read give their exact counters (the live ones are estimates)
    const readPartIds = new Set(
      Object.values(a.stats.stats.parts)
        .filter((ps) => ps.passes > 0)
        .map((ps) => ps.partId),
    );
    const recount: RecountEntry[] = [];
    let unreadableEntries = 0;
    for await (const row of this.takeoutRepository.streamEntriesForExport(exportId, {
      catalogVersion: CATALOG_VERSION,
      excludePartIds: [...(a.ctx?.missingThisAttempt ?? [])],
    })) {
      if (readPartIds.has(row.partId)) {
        recount.push({
          partId: row.partId,
          kind: row.kind,
          size: Number(row.size),
          checksum: row.checksum,
          readError: row.readError,
        });
      }
      entryRefs.push({ partName: row.partName, seq: row.seq, readError: row.readError });
      if (row.readError) {
        unreadableEntries++;
      }
      catalogKeys.add(pathKey(row.path));
      catalogInputs.push({
        partName: row.partName,
        path: row.path,
        size: Number(row.size),
        mtime: row.mtime,
        // an unreadable entry is 'other' for the planner; its row is overridden below (fix F5)
        kind: (row.readError ? 'other' : row.kind) as CatalogInput['kind'],
        json: (row.json as CatalogInput['json']) ?? null,
        checksum: row.readError ? null : row.checksum,
        sample:
          row.width !== null && row.height !== null && row.sample
            ? { width: row.width, height: row.height, sample: row.sample }
            : null,
      });
    }

    const catalog = await buildCatalog(catalogInputs, { banned: DEFAULT_BANNED_PATTERNS });
    const plan = await planImport(catalog, settings as any, { rotationProbe: sampleRotationProbe(catalog) });
    const rows = await this.buildRunFileRows(run, plan);
    for (const [i, file] of plan.files.entries()) {
      const ref = entryRefs[file.catalogIndex];
      rows[i].entrySeq = ref?.seq ?? null;
      if (ref?.readError) {
        rows[i].action = TakeoutRunFileAction.PartUnreadable;
        rows[i].status = TakeoutRunFileStatus.Skipped;
        rows[i].reason = ref.readError;
      }
    }

    // report-only rows after the plan rows (single-pass design 7.2)
    const exp = await this.takeoutRepository.getExport(exportId);
    const parts = await this.takeoutRepository.getPartsByExport(exportId);
    const missingNow = a.ctx?.missingThisAttempt ?? new Set<string>();
    const unreadableParts: UnreadablePart[] = [];
    let seq = rows.length;
    const reportRow = (takeoutPath: string, partName: string | null, action: TakeoutRunFileAction, reason: string) => {
      rows.push({
        runId: run.id,
        seq: seq++,
        takeoutPath,
        partName,
        entrySeq: null,
        size: 0,
        mtime: null,
        checksum: null,
        fileKind: 'other',
        jsonPath: null,
        matcher: null,
        originalFileName: null,
        groupIndex: null,
        groupOrder: null,
        groupKind: null,
        isCover: false,
        action,
        status: TakeoutRunFileStatus.Skipped,
        reason,
        assetId: null,
        smallerAssetId: null,
        plan: null,
        dependsOnSeq: null,
        rotation: 0,
        captureDate: null,
      });
    };
    for (const part of parts) {
      if (part.isIndex) {
        continue;
      }
      const size = Number(part.size);
      if (missingNow.has(part.id) || part.isMissing) {
        reportRow(part.fileName, part.fileName, TakeoutRunFileAction.PartUnreadable, 'archive file missing');
        unreadableParts.push({ fileName: part.fileName, error: 'archive file missing', offset: null, size });
        continue;
      }
      if (part.catalogStatus !== TakeoutCatalogStatus.Error || part.catalogVersion !== CATALOG_VERSION) {
        continue;
      }
      const error = part.catalogError ?? 'unreadable';
      const offset = part.catalogErrorOffset === null ? null : Number(part.catalogErrorOffset);
      let reason: string;
      if (error.startsWith('gzip CRC mismatch')) {
        reason = 'the part is corrupt (gzip CRC mismatch); none of its files was imported; download this part again';
      } else if (part.kind === 'zip') {
        reason = `${error}; no file of this part could be read`;
      } else {
        reason = `${error} at byte ${offset ?? '?'} of ${size}; later files of this part could not be read`;
      }
      reportRow(part.fileName, part.fileName, TakeoutRunFileAction.PartUnreadable, reason);
      unreadableParts.push({ fileName: part.fileName, error, offset, size });
    }

    // index cross-check against the catalog (by pathKey; a name Google shortened in the archive counts as present)
    const indexFiles = await this.indexFiles(a);
    let indexMissing: string[] | null = null;
    let notInIndex = 0;
    if (indexFiles) {
      const check = crossCheckIndex(indexFiles, catalogKeys);
      indexMissing = check.missing;
      notInIndex = check.notInIndex;
      for (const path of check.missing) {
        reportRow(
          path,
          null,
          TakeoutRunFileAction.MissingFromArchive,
          'listed in the Takeout index but not found in any readable part',
        );
      }
    }

    const lastRead: LastReadAnalysis = {
      at: new Date().toISOString(),
      runId: run.id,
      catalogSummary: catalog.summary,
      indexMissingFiles: indexMissing ? { count: indexMissing.length, sample: indexMissing.slice(0, 200) } : null,
      notInIndex,
      unreadableParts,
      unreadableEntries,
    };
    const input = storedAnalysisInput(exp, parts, lastRead);
    const analysis = analyzeExport(input);
    const storedAnalysis = { ...(exp?.analysis as object), ...analysis, lastRead };

    const bytesTotal = rows
      .filter((r) => r.action === TakeoutRunFileAction.Upload && r.status === TakeoutRunFileStatus.Planned)
      .reduce((sum, r) => sum + Number(r.size), 0);
    if (recount.length > 0) {
      const server = await a.ctx!.serverSet();
      recountReadStats(a.stats.stats, recount, {
        onServer: (checksum) => server.has(checksum),
        hasBlob: (key) => a.staging!.hasBlob(key),
      });
    }
    // "deferred" is recounted as planned uploads without a blob
    const withoutBlob = rows.filter(
      (r) =>
        r.action === TakeoutRunFileAction.Upload &&
        r.status === TakeoutRunFileStatus.Planned &&
        r.checksum &&
        !a.staging!.hasBlob(hex(r.checksum)),
    );
    a.stats.stats.deferredFiles = withoutBlob.length;
    a.stats.stats.deferredBytes = withoutBlob.reduce((sum, r) => sum + Number(r.size), 0);
    const nextStatus = withoutBlob.length > 0 ? TakeoutRunStatus.Fetching : TakeoutRunStatus.Importing;

    for (;;) {
      // a pause during planning takes effect here: the plan is committed once the run is resumed
      await this.pausePoint(a);
      const ok = await this.takeoutRepository.commitPlan({
        runId: run.id,
        token: a.token,
        rows,
        nextStatus,
        runPatch: {
          bytesTotal,
          readStats: this.snapshotStats(a) as unknown as object,
          archiveBytesTotal: this.archiveTotal(a),
          archiveBytesRead: Math.min(a.stats.covered(), this.archiveTotal(a)),
        },
        exportId,
        exportPatch: {
          analysis: storedAnalysis,
          completeness: analysis.completeness as any,
          analyzedAt: new Date(),
        },
      });
      if (ok) {
        break;
      }
      if (await this.waitIfPaused(a)) {
        continue;
      }
      const reason = new LeaseLost();
      a.controller.abort(reason);
      throw reason;
    }
    a.status = nextStatus;
    await emitRun(this.lifecycle, run.id);
    await emitExport(this.lifecycle, exportId);
  }

  /** Samples for pairs that have none: from a staged blob, a server original, zip random access, tgz last */
  private async sampleBackfill(a: Attempt, keep: Set<string>) {
    const keepKeys = new Set([...keep].map((path) => pathKey(path)));
    const withoutSample = await this.takeoutRepository.getEntriesWithoutSample(a.run.exportId);
    const candidates = withoutSample.filter((row) => keepKeys.has(pathKey(row.path)));
    if (candidates.length === 0) {
      return;
    }
    const parts = this.usablePartsByName(a);
    const requests: FetchRequest[] = candidates.map((row) => ({
      kind: 'sample',
      checksum: row.checksum!,
      size: Number(row.size),
      occurrences: [
        {
          partName: row.partName,
          kind: parts.get(row.partName)?.kind ?? 'tgz',
          seq: row.seq,
          path: row.path,
          size: Number(row.size),
          endOffset: null,
        },
      ],
      cursor: 0,
      satisfied: false,
      failure: null,
      entryId: row.id,
    }));
    const unserved = await fetchEntries(a.ctx!, parts, requests);
    if (a.ctx!.readAbort.signal.aborted) {
      // a sample that was not computed stays a backfill candidate; it is never recorded as a decode error
      throw a.ctx!.readAbort.signal.reason;
    }
    for (const request of unserved) {
      await this.takeoutRepository.updateEntry(request.entryId!, { sampleSkipped: 'decodeError' as any });
    }
  }

  private usablePartsByName(a: Attempt): Map<string, ReadPartRow> {
    return new Map(a.parts.filter((p) => !p.isMissing).map((p) => [p.fileName, p]));
  }

  // ---------- repair (single-pass design 9.1) ----------

  /** Every asset-less target back to staging (complete) or unlinked; a target whose asset exists becomes created */
  private async phaseRepair(a: Attempt) {
    this.throwIfAborted(a);
    await reclaimRunTargets(this.lifecycle, a.runId, a.staging, 'stage');
  }

  // ---------- phase: fetching (single-pass design 8) ----------

  private async phaseFetching(a: Attempt) {
    this.throwIfAborted(a);
    const run = a.run;
    let rows = await this.takeoutRepository.getRunFilesForImport(a.runId);

    // 8.1.1 server re-check: files imported meanwhile by another client are neither fetched nor moved
    const plannedUploads = rows.filter(
      (r) => r.action === TakeoutRunFileAction.Upload && r.status === TakeoutRunFileStatus.Planned && r.checksum,
    );
    for (let i = 0; i < plannedUploads.length; i += 500) {
      const batch = plannedUploads.slice(i, i + 500);
      const hits = await this.takeoutRepository.getUploadAssetsByChecksums(
        run.userId,
        batch.map((r) => r.checksum!),
      );
      const byHex = new Map(hits.map((hit) => [hit.checksum.toString('hex'), hit]));
      for (const row of batch) {
        const hit = byHex.get(row.checksum!.toString('hex'));
        if (hit) {
          await this.takeoutRepository.updateRunFile(row.id, {
            action: TakeoutRunFileAction.ServerDuplicate,
            assetId: hit.id,
            reason: hit.deletedAt ? IN_TRASH_REASON : 'already on the server',
          });
        }
      }
    }
    rows = await this.takeoutRepository.getRunFilesForImport(a.runId);
    const missing = rows.filter(
      (r) =>
        r.action === TakeoutRunFileAction.Upload &&
        r.status === TakeoutRunFileStatus.Planned &&
        r.checksum &&
        !a.staging!.hasBlob(hex(r.checksum)),
    );
    if (missing.length === 0) {
      return;
    }
    await this.setStatus(a, TakeoutRunStatus.Fetching);

    // 8.1.2 exact space check (plan rows are committed: a Resume after freeing space skips reading and planning)
    let need = missing.reduce((sum, r) => sum + Number(r.size), 0);
    if (a.staging!.crossDevice) {
      need += rows
        .filter((r) => r.action === TakeoutRunFileAction.Upload && r.status === TakeoutRunFileStatus.Planned)
        .reduce((sum, r) => sum + Number(r.size), 0);
    }
    const available = await this.availableBytesWithin(a).catch((error: unknown) => {
      if (error instanceof RunFailure) {
        throw error;
      }
      return Infinity;
    });
    const usable = available - this.readLimits.freeSpaceReserve;
    if (usable < need) {
      throw new RunFailure(`Not enough free space: ${formatBytes(need - usable)} more needed`);
    }

    const unserved = await fetchEntries(a.ctx!, this.usablePartsByName(a), await this.fetchRequests(a, missing));
    const failures = new Map(unserved.map((request) => [hex(request.checksum), request.failure]));
    for (const row of missing) {
      const failure = failures.get(hex(row.checksum!));
      if (failure === undefined) {
        continue;
      }
      await this.takeoutRepository.updateRunFile(row.id, {
        status: TakeoutRunFileStatus.Error,
        error: failure ?? 'file not found in the archive',
      });
    }
    await this.persistProgress(a);
  }

  /** One request per distinct checksum (R2-B3), every catalogued occurrence a fallback; legacy rows by path */
  private async fetchRequests(a: Attempt, rows: any[]): Promise<FetchRequest[]> {
    const parts = this.usablePartsByName(a);
    const byHex = new Map<string, FetchRequest>();
    for (const row of rows) {
      const h = hex(row.checksum);
      let request = byHex.get(h);
      if (!request) {
        request = {
          kind: 'blob',
          checksum: row.checksum,
          size: Number(row.size),
          occurrences: [],
          cursor: 0,
          satisfied: false,
          failure: null,
        };
        byHex.set(h, request);
      }
      if (row.entrySeq === null && row.partName) {
        // planned by the old code: no entry position, located by (part, path, size)
        request.occurrences.push({
          partName: row.partName,
          kind: parts.get(row.partName)?.kind ?? 'tgz',
          seq: null,
          path: row.takeoutPath,
          size: Number(row.size),
          endOffset: null,
        });
      }
    }
    const checksums = byHex
      .values()
      .map((request) => request.checksum)
      .toArray();
    for (let i = 0; i < checksums.length; i += 500) {
      const occurrences = await this.takeoutRepository.getEntryOccurrences(
        a.run.exportId,
        checksums.slice(i, i + 500),
        CATALOG_VERSION,
      );
      for (const occurrence of occurrences) {
        const request = byHex.get(occurrence.checksum!.toString('hex'));
        request?.occurrences.push({
          partName: occurrence.partName,
          kind: occurrence.kind,
          seq: occurrence.seq,
          path: occurrence.path,
          size: Number(occurrence.size),
          endOffset: occurrence.endOffset === null ? null : Number(occurrence.endOffset),
        } satisfies FetchOccurrence);
      }
    }
    return byHex.values().toArray();
  }

  // ---------- phase: importing (single-pass design 9.2) ----------

  private async phaseImporting(a: Attempt) {
    await this.setStatus(a, TakeoutRunStatus.Importing);
    const run = a.run;
    const settings = mergeRunSettings(run.settings);
    const rows = await this.takeoutRepository.getRunFilesForImport(a.runId);
    // fix F17: the error policy counts the errors of this attempt only
    const errorBaseline = rows.filter((r) => r.status === TakeoutRunFileStatus.Error).length;

    const byGroup = new Map<number, any[]>();
    for (const row of rows) {
      if (row.groupIndex === null) {
        continue;
      }
      const list = byGroup.get(row.groupIndex) ?? [];
      list.push(row);
      byGroup.set(row.groupIndex, list);
    }

    const quotaUser = await this.userRepository.get(run.userId, {} as any).catch(() => null);
    const quota = {
      limit: quotaUser?.quotaSizeInBytes ?? null,
      base: Number(quotaUser?.quotaUsageInBytes ?? 0),
      created: 0,
    };
    let bytesDone = Number(run.bytesDone ?? 0);
    // bytesDone counts created assets only: the total is what is done plus the uploads still planned, so the rows
    // the server re-check or fetching took out of the plan leave the bar at 100% when the last asset is created
    let bytesTotal =
      bytesDone +
      rows
        .filter((r) => r.action === TakeoutRunFileAction.Upload && r.status === TakeoutRunFileStatus.Planned)
        .reduce((sum, r) => sum + Number(r.size), 0);
    await this.takeoutRepository.updateRunIfLeased(a.runId, a.token, { bytesTotal });

    const order = orderGroups(
      byGroup.keys(),
      groupEdges(
        rows.map((row) => ({
          seq: row.seq,
          groupIndex: row.groupIndex,
          dependsOnSeq: row.dependsOnSeq,
          isCover: row.isCover,
          links: ((row.plan as any)?.links ?? []) as number[],
        })),
      ),
    );
    for (const groupIndex of order) {
      if (a.signal.aborted) {
        break;
      }
      // a pause takes effect between groups: every file of the last group has its asset or went back to staging
      await this.pausePoint(a);
      const members = byGroup.get(groupIndex)!;
      if (members.every((m) => TERMINAL_ROW_STATUSES.has(m.status)) && !this.stackPending(members, rows)) {
        continue;
      }
      let pending = 0;
      const written: any[] = [];
      for (const m of members) {
        if (m.action !== TakeoutRunFileAction.Upload || m.status !== TakeoutRunFileStatus.Planned) {
          continue;
        }
        if (!m.checksum) {
          await this.takeoutRepository.updateRunFile(m.id, {
            status: TakeoutRunFileStatus.Error,
            error: 'the file has no checksum',
          });
          m.status = TakeoutRunFileStatus.Error;
          continue;
        }
        if (quota.limit !== null && quota.base + quota.created + pending + Number(m.size) > quota.limit) {
          // the row stays planned: Resume imports it once the quota allows (fix F16)
          throw new RunFailure('quota exceeded');
        }
        const uuid = m.newAssetId ?? randomUUID();
        const ext = extname(m.originalFileName ?? m.takeoutPath).toLowerCase();
        const targetPath = StorageCore.getNestedPath(StorageFolder.Upload, run.userId, `${uuid}${ext}`);
        // recorded before the rename: repair relies on it
        await this.takeoutRepository.updateRunFile(m.id, { newAssetId: uuid, targetPath });
        m.newAssetId = uuid;
        m.targetPath = targetPath;
        let moved = await a.staging!.moveTo(hex(m.checksum), targetPath, Number(m.size));
        if (moved === 'missing') {
          // the blob vanished (hand deletion, race): fetch this one entry inline
          await fetchEntries(a.ctx!, this.usablePartsByName(a), await this.fetchRequests(a, [m]));
          moved = await a.staging!.moveTo(hex(m.checksum), targetPath, Number(m.size));
          if (moved === 'missing') {
            await this.takeoutRepository.updateRunFile(m.id, {
              targetPath: null,
              status: TakeoutRunFileStatus.Error,
              error: 'staged file missing',
            });
            m.targetPath = null;
            m.status = TakeoutRunFileStatus.Error;
            continue;
          }
        }
        await this.takeoutRepository.updateRunFile(m.id, { status: TakeoutRunFileStatus.Written });
        m.status = TakeoutRunFileStatus.Written;
        pending += Number(m.size);
        written.push(m);
      }
      if (written.length > 0) {
        await this.takeoutRepository.updateRunIfLeased(a.runId, a.token, { currentFile: written[0].takeoutPath });
      }
      await this.processGroup(run, settings, groupIndex, byGroup, rows, errorBaseline, a.staging);
      // only assets actually created count for the quota and the progress (a server duplicate does not)
      const created = written
        .filter(
          (m) =>
            m.action === TakeoutRunFileAction.Upload &&
            (m.status === TakeoutRunFileStatus.Created || m.status === TakeoutRunFileStatus.Done),
        )
        .reduce((sum, m) => sum + Number(m.size), 0);
      quota.created += created;
      // so do the files the import itself took out of the plan: a server duplicate, a skipped previously deleted file
      const dropped = written
        .filter((m) => m.action !== TakeoutRunFileAction.Upload)
        .reduce((sum, m) => sum + Number(m.size), 0);
      if (created > 0 || dropped > 0) {
        bytesDone += created;
        bytesTotal -= dropped;
        await this.takeoutRepository.updateRunIfLeased(a.runId, a.token, { bytesDone, bytesTotal });
      }
    }
    if (a.signal.aborted) {
      return;
    }

    // section 11 D1: rotate each rotate-only-pair original, re-detect its faces and reconcile the dropped copy's
    // named people, then drop the copy. Runs after uploads so the originals exist.
    if (settings.applyRotation) {
      await this.phaseRotateFaces(run, settings, rows, a);
    }
  }

  /** stackIds would stack 2 or more assets and no member carries the stacked flag yet */
  private stackPending(members: any[], allRows: any[]): boolean {
    const ids = this.stackIds(members, allRows);
    return ids.length >= 2 && members.every((m) => !(m.fallbacks ?? []).includes('stacked'));
  }

  /**
   * The assets a group stacks. A re-import of a previously deleted file stays on its own, like an upload of it: it is
   * in the trash or in the "Previously deleted" album for review, and a trashed stack cover would hide the stack.
   * A server duplicate in the trash stays out too: the user deleted it, and as the cover it would hide the stack.
   */
  private stackIds(members: any[], allRows: any[]): string[] {
    return assembleStackIds(
      members
        .filter(
          (m) =>
            m.status === TakeoutRunFileStatus.Done &&
            m.assetId &&
            previouslyDeletedFlags(m).length === 0 &&
            m.reason !== IN_TRASH_REASON,
        )
        .sort((x, y) => (x.groupOrder ?? 0) - (y.groupOrder ?? 0))
        .map((m) => ({ assetId: m.assetId, smallerAssetId: m.smallerAssetId })),
      this.linkAssetIds(members, allRows),
    );
  }

  // ---------- phase: finishing (single-pass design 9.3) ----------

  private async phaseFinishing(a: Attempt) {
    await this.setStatus(a, TakeoutRunStatus.Finishing);
    const runId = a.runId;
    await this.pausePoint(a, { checkAbort: false });
    // error rows keep no file: staging is discarded next, so unlink
    for (const row of await this.takeoutRepository.getRunFilesWithTarget(runId)) {
      if (row.status !== TakeoutRunFileStatus.Error || row.action !== TakeoutRunFileAction.Upload) {
        continue;
      }
      const result = await a.staging!.reclaim(row, 'unlink');
      await applyReclaim(this.takeoutRepository, row, result);
    }

    // Finding T9/#9: verify each created asset's post-import state and re-queue the jobs that silently did not run
    await verifyAndRequeue(this.lifecycle, await this.takeoutRepository.getRunFilesForImport(runId));
    // the last safe point: once the staging is discarded the run completes, a pause from then on included
    await this.pausePoint(a, { checkAbort: false });

    const run = (await this.takeoutRepository.getRun(runId))!;
    const counters = countersFromRows((await this.takeoutRepository.getCounterRows(runId)) as any, {
      total: Number(run.bytesTotal),
      done: Number(run.bytesDone),
    });
    const held = await a.staging!.bytesHeld();
    a.stats.stats.discardedStagedFiles = held.files;
    a.stats.stats.discardedStagedBytes = held.bytes;
    a.stats.stats.stagingBytes = 0;
    a.stats.stats.stagingExpiresAt = null;
    a.stats.stats.etaSeconds = null;
    await a.staging!.discard();
    // every file is imported: a cancel (requestCancel keeps the lease) or a pause that arrived meanwhile still ends
    // completed
    const ok = await this.takeoutRepository.finishRunCas(
      runId,
      [TakeoutRunStatus.Finishing, TakeoutRunStatus.Cancelling, TakeoutRunStatus.Paused],
      a.token,
      TakeoutRunStatus.Completed,
      {
        counters: counters as unknown as object,
        finishedAt: new Date(),
        currentFile: null,
        hasStaging: false,
        readStats: this.snapshotStats(a) as unknown as object,
        archiveBytesRead: this.archiveTotal(a),
      },
    );
    if (!ok) {
      return;
    }

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
    await queueAnalysis(this.lifecycle, run.exportId).catch(() => {});
    await emitRun(this.lifecycle, runId);
    this.albumCache.delete(runId);
  }

  // ---------- parking a paused run (parkIfBlocking) ----------

  /**
   * The paused run gives its queue place back: it stays paused, as after a restart while paused (its lease is released,
   * its parts wait), and Resume queues it again. Resumed or cancelled while the attempt stopped: queued again now, or
   * cleaned up like any cancel.
   */
  private async parkRun(a: Attempt) {
    const runId = a.runId;
    try {
      // the job stops like after a failure: a file taken out of staging for an asset goes back to it
      await reclaimRunTargets(this.lifecycle, runId, a.staging, 'stage');
    } catch (error) {
      this.logger.warn(`Takeout run ${runId}: reclaim failed, the next attempt repairs it: ${messageOf(error)}`);
    }
    await this.takeoutRepository.updatePartsOfRun(runId).catch(() => {});
    const readStats = await stopReadingParts(this.lifecycle, this.snapshotStats(a));
    // the progress write keeps the pause the API wrote (pausedAt, pausedFrom): Resume reads it
    await this.takeoutRepository
      .updateRunIfLeased(runId, a.token, {
        readStats: readStats as unknown as object,
        archiveBytesTotal: this.archiveTotal(a),
        archiveBytesRead: Math.min(a.stats.covered(), this.archiveTotal(a)),
      })
      .catch(() => false);
    const parked = await this.takeoutRepository
      .finishRunCas(runId, [TakeoutRunStatus.Paused], a.token, TakeoutRunStatus.Paused, { heartbeatAt: null })
      .catch(() => false);
    if (parked) {
      await emitRun(this.lifecycle, runId);
      return;
    }
    const current = await this.takeoutRepository.getRun(runId);
    if (current?.status === TakeoutRunStatus.Cancelling) {
      await cleanupCancelledRun(this.lifecycle, runId, {
        token: a.token,
        from: [TakeoutRunStatus.Cancelling],
        readStats: this.snapshotStats(a),
      });
      return;
    }
    if (current && current.leaseToken === a.token && TAKEOUT_RUNNING_RUN_STATUSES.includes(current.status)) {
      // resumed while the attempt stopped: the next attempt continues it, like a Resume after a restart
      const attempt = current.attempt + 1;
      const requeued = await this.takeoutRepository.finishRunCas(
        runId,
        TAKEOUT_RUNNING_RUN_STATUSES,
        a.token,
        TakeoutRunStatus.Queued,
        { heartbeatAt: null, attempt },
      );
      if (requeued) {
        await this.jobRepository.queue({ name: JobName.TakeoutRun, data: { runId, attempt } });
        await emitRun(this.lifecycle, runId);
      }
    }
  }

  // ---------- failure (single-pass design 10.2) ----------

  private async failRun(a: Attempt, reason: Error) {
    const runId = a.runId;
    this.logger.error(`Takeout run ${runId} failed: ${reason.message}`);
    try {
      await reclaimRunTargets(this.lifecycle, runId, a.staging, 'stage');
    } catch (error) {
      // the share is unreachable: the boot step finishes the reclaim
      this.logger.warn(`Takeout run ${runId}: reclaim failed, boot recovery retries it: ${messageOf(error)}`);
    }
    await this.takeoutRepository.updatePartsOfRun(runId).catch(() => {});
    if (a.staging) {
      const held = await a.staging.bytesHeld().catch(() => ({ bytes: 0 }));
      a.stats.stats.stagingBytes = held.bytes;
      a.stats.stats.stagingExpiresAt = new Date(Date.now() + STAGING_TTL_MS).toISOString();
    }
    a.stats.stats.etaSeconds = null;
    const run = await this.takeoutRepository.getRun(runId);
    const counters = run
      ? countersFromRows((await this.takeoutRepository.getCounterRows(runId)) as any, {
          total: Number(run.bytesTotal),
          done: Number(run.bytesDone),
        })
      : null;
    // a run that fails while paused (a write that failed before the pause) fails too
    const ok = await this.takeoutRepository
      .finishRunCas(runId, TAKEOUT_LEASED_RUN_STATUSES, a.token, TakeoutRunStatus.Failed, {
        error: reason.message,
        finishedAt: new Date(),
        currentFile: null,
        readStats: (await stopReadingParts(this.lifecycle, this.snapshotStats(a))) as unknown as object,
        ...(counters && { counters: counters as unknown as object }),
      })
      .catch(() => false);
    if (!ok) {
      // cancelled while it failed: the cancel wins (it keeps the lease of this job), never a run left cancelling
      const current = await this.takeoutRepository.getRun(runId);
      if (current?.status === TakeoutRunStatus.Cancelling) {
        await cleanupCancelledRun(this.lifecycle, runId, {
          token: a.token,
          from: [TakeoutRunStatus.Cancelling],
          readStats: this.snapshotStats(a),
        });
      }
      return;
    }
    if (run) {
      await queueAnalysis(this.lifecycle, run.exportId).catch(() => {});
    }
    await emitRun(this.lifecycle, runId);
  }

  // ---------- progress (single-pass design 6.9, 13.2) ----------

  private archiveTotal(a: Attempt): number {
    return Number(a.run.archiveBytesTotal ?? 0) + (a.ctx?.archiveTotalGrowth ?? 0);
  }

  private snapshotStats(a: Attempt) {
    const stats = a.stats.stats;
    for (const ps of Object.values(stats.parts)) {
      a.stats.sync(ps);
    }
    a.stats.syncFetch();
    stats.transportRetries = a.stats.transportRetries();
    if (a.staging) {
      stats.crossDevice ||= a.staging.crossDevice;
    }
    return stats;
  }

  private async persistProgress(a: Attempt) {
    const total = this.archiveTotal(a);
    await this.takeoutRepository.updateRunIfLeased(a.runId, a.token, {
      readStats: this.snapshotStats(a) as unknown as object,
      archiveBytesTotal: total,
      archiveBytesRead: Math.min(a.stats.covered(), total),
    });
  }

  private emitExportThrottled(a: Attempt, force = false) {
    const now = Date.now();
    if (!force && now - a.lastExportEmit < 1000) {
      return;
    }
    a.lastExportEmit = now;
    void emitExport(this.lifecycle, a.run.exportId).catch(() => {});
  }

  /**
   * The 2 s tick: cancel fallback, budget refresh, persisted progress and the run event. It never waits for the
   * file system: statfs runs in the background (the budget keeps its last value), so a share that stops answering
   * cannot stop the ticks; the stall watchdog runs on every interval callback (handleRun).
   */
  private async tickProgress(a: Attempt) {
    const { run, read } = await this.readStatus(a);
    if (!run || !TAKEOUT_LEASED_RUN_STATUSES.includes(run.status)) {
      // the 2 s poll is the fallback when the TakeoutRunCancel server event did not reach this worker
      a.controller.abort(run?.status === TakeoutRunStatus.Cancelling ? new CancelReason() : new LeaseLost());
      return;
    }
    // and when the TakeoutRunPause server event did not
    this.syncPause(a, run, read);
    // a paused attempt waiting in its reads never reaches a pause point
    await this.parkIfBlocking(a);
    const now = Date.now();
    if (a.ctx && now - a.lastStatfs >= STATFS_REFRESH_MS) {
      a.lastStatfs = now;
      a.ctx.budget.refreshInBackground();
      // the bytes read so far of the parts being read, for the parts table
      for (const { partId } of a.stats.meters()) {
        const ps = a.stats.stats.parts[partId];
        a.stats.sync(ps);
        await this.takeoutRepository.updatePart(partId, { bytesRead: ps.bytesRead });
      }
    }
    const total = this.archiveTotal(a);
    if (!a.pause.isOpen) {
      // no estimate while paused; the rate samples skip the pause (resumeAttempt)
      a.stats.stats.etaSeconds = null;
    } else if (a.status === TakeoutRunStatus.Reading) {
      a.stats.stats.etaSeconds = a.stats.eta(total, Math.max(1, a.ctx?.readers ?? a.stats.stats.readers));
    } else if (a.status === TakeoutRunStatus.Fetching) {
      a.stats.stats.etaSeconds = a.stats.fetchEta();
    } else {
      a.stats.stats.etaSeconds = null;
    }
    const patch: Record<string, unknown> = {
      readStats: this.snapshotStats(a),
      archiveBytesTotal: total,
      archiveBytesRead: Math.min(a.stats.covered(), total),
    };
    if (a.status === TakeoutRunStatus.Importing) {
      const rows = await this.takeoutRepository.getCounterRows(a.runId);
      patch.counters = countersFromRows(rows as any, { total: Number(run.bytesTotal), done: Number(run.bytesDone) });
    }
    if (await this.takeoutRepository.updateRunIfLeased(a.runId, a.token, patch)) {
      await emitRun(this.lifecycle, a.runId);
    }
    if (a.status === TakeoutRunStatus.Reading) {
      this.emitExportThrottled(a);
    }
  }

  /** @deprecated kept for the existing specs: see verifyAndRequeue in takeout-lifecycle */
  private async verifyAndRequeue(rows: any[]) {
    await verifyAndRequeue(this.lifecycle, rows);
  }

  /** Map the frozen plan into takeout_run_file rows, applying the server pre-check (2.6 step 4). */
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

    // name + time pre-check (DEV 5): a non-edited upload whose on-disk name and capture time match a
    // pre-existing server asset is a server twin. same size -> serverDuplicate; local bigger -> upload
    // keeping the smaller server asset (larger version pair); local smaller -> betterOnServer.
    // Like Go's ShouldUpload, every server asset of the name is a candidate, also one that another file of this
    // Takeout duplicates exactly: an album copy Google exported without the motion clip of its year copy is
    // beaten by that year copy on the server, not uploaded a second time.
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
        if (cand.fileSizeInByte === null || cand.fileSizeInByte === undefined) {
          continue;
        }
        const list = nameCandidates.get(key) ?? [];
        list.push({ id: cand.id, at: cand.at ? new Date(cand.at) : null, size: Number(cand.fileSizeInByte) });
        nameCandidates.set(key, list);
      }
    }
    // Go's name + time index also holds the assets uploaded earlier in the same run: of two new copies of one photo
    // in this Takeout only the larger is uploaded, the smaller follows it (a server twin still comes first)
    const largerCopyOf = largerCopiesInTakeout(plan.files);

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
          reason = hit.deletedAt ? IN_TRASH_REASON : 'already on the server';
        } else if (hex && seenChecksum.has(hex)) {
          action = TakeoutRunFileAction.AlreadyProcessed;
          status = TakeoutRunFileStatus.Planned;
          dependsOnSeq = seenChecksum.get(hex)!;
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
          } else if (largerCopyOf.has(file.key)) {
            // another copy of the larger file: processed after it, on its asset (seq === key)
            action = TakeoutRunFileAction.AlreadyProcessed;
            status = TakeoutRunFileStatus.Planned;
            dependsOnSeq = largerCopyOf.get(file.key)!;
            reason = LARGER_COPY_REASON;
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

    // a smaller copy adds its albums to the asset of its larger copy when it is processed; its tags and favorite go
    // into the upload of the larger copy, which writes them before the metadata extraction of the new asset. A larger
    // copy that the server already has follows the server rules, like its smaller copy (rows[seq].seq === seq).
    for (const row of rows) {
      if (row.reason !== LARGER_COPY_REASON) {
        continue;
      }
      const larger = rows[row.dependsOnSeq];
      if (larger?.action !== TakeoutRunFileAction.Upload || !larger.plan || !row.plan) {
        continue;
      }
      larger.plan.tags = dedupeTags([...(larger.plan.tags ?? []), ...(row.plan.tags ?? [])]);
      larger.plan.favorited = !!larger.plan.favorited || !!row.plan.favorited;
    }
    return rows;
  }

  // ---------- section 11 D1: rotate-only face preservation ----------

  /**
   * For every rotate-only-pair original the planner reported, run the D1 sequence in order (spec 11): (1) apply the
   * rotation edit to the original so it is upright, (2) queue + await face detection on the now-upright original,
   * (3) reconcile the named people that belonged to the dropped copy onto the original, and only THEN (4) drop the
   * copy. The copy is never uploaded, so "drop" is finalising its already-dropped row; it is done last so the
   * original always has the re-detected faces and reconciled people before the copy is discarded.
   */
  private async phaseRotateFaces(run: any, settings: any, rows: any[], a?: Attempt) {
    const bySeq = new Map<number, any>(rows.map((r) => [r.seq, r]));
    // two originals can share one asset (an upload and an alreadyProcessed copy of it): the rotation and the face
    // detection run once per asset, and every original of that asset reports the state of that one rotation
    const rotated = new Map<string, TakeoutRotationState>();
    const detected = new Set<string>();
    for (const original of rows) {
      const plan = (original.plan ?? {}) as any;
      if (!plan.rotateOriginal || !original.assetId) {
        continue;
      }
      if (original.status !== TakeoutRunFileStatus.Created && original.status !== TakeoutRunFileStatus.Done) {
        continue;
      }
      if (a) {
        await this.pausePoint(a);
      }
      const angle = Number(plan.rotateAngle ?? original.rotation ?? 0);
      const copySeqs: number[] = plan.rotateCopySeqs ?? [];
      const copyRows = copySeqs.map((s) => bySeq.get(s)).filter((r): r is any => !!r);
      try {
        // (1) rotate the original upright. Ensure its EXIF dimensions exist first (rotation needs them); a synchronous
        // metadata run is idempotent and lets the edit apply here rather than via the async hook.
        if (angle !== 0) {
          let state = rotated.get(original.assetId);
          if (state === undefined) {
            await this.jobRepository.run({
              name: JobName.AssetExtractMetadata,
              data: { id: original.assetId, source: 'upload' },
            });
            state = await this.applyRotationNow(original.assetId, angle);
            rotated.set(original.assetId, state);
          }
          await this.takeoutRepository.updateRunFile(original.id, { rotationState: state });
          original.rotationState = state;
        }

        // (2) queue + await face detection on the now-upright original (the repo's detect path yields correct
        // face positions natively).
        if (!detected.has(original.assetId)) {
          await this.jobRepository.run({
            name: JobName.AssetDetectFaces,
            data: { id: original.assetId, source: 'upload' },
          });
          detected.add(original.assetId);
        }

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

  // ---------- per-group processing (2.7) ----------

  private async processGroup(
    run: any,
    settings: any,
    groupIndex: number,
    byGroup: Map<number, any[]>,
    allRows: any[],
    errorBaseline = 0,
    staging: StagingStore | null = null,
  ) {
    // upload members first, then existing-asset members, each by group order (R1-D1): an alreadyProcessed row always
    // finds its source's asset when both are in one group
    const members = [...(byGroup.get(groupIndex) ?? [])].sort(
      (x, y) => uploadFirst(x) - uploadFirst(y) || (x.groupOrder ?? 0) - (y.groupOrder ?? 0),
    );
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
        const previous = row.status;
        row.status = TakeoutRunFileStatus.Error;
        // fix F18: a row that errors without an asset leaves no file under upload/
        if (row.action === TakeoutRunFileAction.Upload && row.targetPath) {
          await this.reclaimErrorRow(row, previous, staging);
        }
      }
    }
    await this.stackGroup(run, members, allRows);
    const groupHadError = members.some((m) => m.status === TakeoutRunFileStatus.Error && !preError.has(m.id));
    this.evaluateErrorPolicy(settings, allRows, groupHadError, errorBaseline);
  }

  private async reclaimErrorRow(row: any, previousStatus: string, staging: StagingStore | null) {
    const reclaimRow = {
      id: row.id,
      status: previousStatus,
      targetPath: row.targetPath,
      newAssetId: row.newAssetId,
      size: row.size,
      checksum: row.checksum,
      entrySeq: row.entrySeq ?? null,
    };
    try {
      const [asset] = row.newAssetId ? await this.assetRepository.getByIds([row.newAssetId]) : [];
      if (asset) {
        return;
      }
      if (staging) {
        await staging.reclaim(reclaimRow, 'stage');
      } else {
        await unlinkTarget(row.targetPath, this.stagingFs).catch(() => {});
      }
      await this.takeoutRepository.updateRunFile(row.id, { targetPath: null });
      row.targetPath = null;
    } catch (error) {
      this.logger.warn(`Takeout: could not reclaim ${row.targetPath}: ${messageOf(error)}`);
    }
  }

  /**
   * Apply the onErrors / stopAfterErrors policy (2.6). `stop` halts the run as failed after the first group that
   * produced an errored row; `continue` with stopAfterErrors=N halts once N errors happened in this attempt (fix F17:
   * errors of earlier attempts do not count again). Both are resumable through handleRun's failure path.
   */
  private evaluateErrorPolicy(settings: any, allRows: any[], justErrored: boolean, errorBaseline = 0) {
    if (settings.onErrors === TakeoutOnErrors.Stop) {
      if (justErrored) {
        throw new RunFailure('stopped after an error');
      }
      return;
    }
    const limit = Number(settings.stopAfterErrors ?? 0);
    if (limit > 0) {
      const errors = allRows.filter((r) => r.status === TakeoutRunFileStatus.Error).length - errorBaseline;
      if (errors >= limit) {
        throw new RunFailure('stopped after reaching the error limit');
      }
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
    // No zone evidence (flagged zoneAssumed): no zone is invented, the moment shows in UTC. A guessed home zone was
    // wrong for every capture away from home; a file or rule that knows its offset always supplies it.
    const zone = capture.zone;
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
      // a file the user permanently deleted before is handled exactly like an upload of it (utils/deleted-reimport)
      const deletedReimport = await checkDeletedReimport(this.deletedReimportRepositories, {
        userId: run.userId,
        checksum: row.checksum,
      });
      if (deletedReimport?.skip) {
        await onDeletedReimport(this.deletedReimportRepositories, deletedReimport);
        await this.skipPreviouslyDeleted(row);
        return;
      }

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
          await unlinkTarget(targetPath, this.stagingFs).catch(() => {});
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

      if (deletedReimport) {
        // right after the asset exists, before its row says so: a resume adopts the asset without asking again
        await onDeletedReimport(this.deletedReimportRepositories, deletedReimport, asset);
        fallbacks.push(`${PREVIOUSLY_DELETED_FLAG}:${deletedReimport.mode}`);
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
    const resultFlags: string[] = assetTags.length > 0 ? ['tagged'] : [];
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
      // writeTags reports false on a failed write once fix/tag-sidecar-race is present; older builds return void
      const written: unknown = await this.metadataRepository.writeTags(sidecarPath, sidecarTags as any);
      if (written !== false) {
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
    row.fallbacks = fallbacks;

    resultFlags.push(...(await this.addAlbums(run, settings, row, asset.id, plan)));
    if (await this.saveGoogleMetadata(run, settings, asset.id, plan, false)) {
      resultFlags.push('metadataSaved');
    }
    await this.addResultFlags(row, resultFlags);

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
    const resultFlags: string[] = [];
    if (row.action === TakeoutRunFileAction.AlreadyProcessed && row.dependsOnSeq !== null) {
      const dep = allRows.find((r) => r.seq === row.dependsOnSeq);
      if (dep?.action === TakeoutRunFileAction.PreviouslyDeletedSkipped) {
        // another copy of a file that is not imported because the user deleted it before
        await this.skipPreviouslyDeleted(row);
        return;
      }
      assetId = dep?.assetId ?? null;
      // the asset is the re-import of a previously deleted file: the report says so on this copy too
      resultFlags.push(...previouslyDeletedFlags(dep));
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
      await unlinkTarget(row.targetPath, this.stagingFs).catch(() => {});
    }

    resultFlags.push(...(await this.addAlbums(run, settings, row, assetId, plan)));
    if (settings.tagServerDuplicates && (await this.addTags(run, settings, row, assetId, plan, true))) {
      resultFlags.push('tagged');
    }
    const alreadyHasMeta = row.action === TakeoutRunFileAction.AlreadyProcessed;
    if (await this.saveGoogleMetadata(run, settings, assetId, plan, alreadyHasMeta)) {
      resultFlags.push('metadataSaved');
    }
    await this.addResultFlags(row, resultFlags);

    // a rotate-only-pair original (section 11 D1) is rotated by phaseRotateFaces, never here or by the async hook:
    // a pending row would let the hook apply the edit first, and D1 would then report it as skippedHasEdits
    if (
      row.action !== TakeoutRunFileAction.BetterOnServer &&
      (row.rotation ?? 0) !== 0 &&
      settings.applyRotation &&
      !plan.rotateOriginal
    ) {
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

  /** Not imported because the user permanently deleted the file before (skip mode): a report row, no file kept */
  private async skipPreviouslyDeleted(row: any) {
    if (row.targetPath) {
      await unlinkTarget(row.targetPath, this.stagingFs).catch(() => {});
    }
    await this.takeoutRepository.updateRunFile(row.id, {
      action: TakeoutRunFileAction.PreviouslyDeletedSkipped,
      status: TakeoutRunFileStatus.Skipped,
      reason: PREVIOUSLY_DELETED_REASON,
      targetPath: null,
    });
    row.action = TakeoutRunFileAction.PreviouslyDeletedSkipped;
    row.status = TakeoutRunFileStatus.Skipped;
    row.reason = PREVIOUSLY_DELETED_REASON;
    row.targetPath = null;
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
    // an alreadyProcessed row resolved its asset from its source row: keep it on the report
    await this.takeoutRepository.updateRunFile(row.id, {
      status: TakeoutRunFileStatus.Done,
      plan: reduced,
      ...(row.assetId && { assetId: row.assetId }),
    });
    row.status = TakeoutRunFileStatus.Done;
    row.plan = reduced;
  }

  /** Record result counters on the row (counters.ts reads them from fallbacks: albumAdded, albumCreated:<title>, ...). */
  private async addResultFlags(row: any, flags: string[]) {
    const fallbacks: string[] = [...(row.fallbacks ?? [])];
    let changed = false;
    for (const flag of flags) {
      if (fallbacks.includes(flag)) {
        continue;
      }

      fallbacks.push(flag);
      changed = true;
    }
    if (changed) {
      row.fallbacks = fallbacks;
      await this.takeoutRepository.updateRunFile(row.id, { fallbacks });
    }
  }

  /** Returns the counter flags: albumAdded when added to any album, albumCreated:<title> per album it created. */
  private async addAlbums(run: any, settings: any, row: any, assetId: string, plan: any): Promise<string[]> {
    const flags: string[] = [];
    if (!settings.syncAlbums) {
      return flags;
    }
    for (const album of plan.albums ?? []) {
      const { albumId, created } = await this.resolveAlbum(run, album);
      if (created) {
        flags.push(`albumCreated:${album.title}`);
      }
      const added = await this.albumRepository
        .addAssetIds(albumId, [assetId])
        .then(() => true)
        .catch(() => false);
      if (added && !flags.includes('albumAdded')) {
        flags.push('albumAdded');
      }
    }
    return flags;
  }

  private albumCache = new Map<string, Map<string, string>>();

  private async resolveAlbum(
    run: any,
    album: { title: string; description?: string },
  ): Promise<{ albumId: string; created: boolean }> {
    let cache = this.albumCache.get(run.id);
    if (!cache) {
      cache = new Map();
      this.albumCache.set(run.id, cache);
    }
    const key = album.title;
    if (cache.has(key)) {
      return { albumId: cache.get(key)!, created: false };
    }
    const owned = await this.albumRepository.getAll(run.userId, { name: album.title }).catch(() => []);
    const existing = (owned as any[])
      .filter((a) => a.albumName === album.title)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
    let albumId: string;
    let created = false;
    if (existing) {
      albumId = existing.id;
    } else {
      const newAlbum = await this.albumRepository.create(
        { albumName: album.title, description: album.description ?? '' },
        [],
        [{ userId: run.userId, role: AlbumUserRole.Owner }],
        run.userId,
      );
      albumId = newAlbum.id;
      created = true;
    }
    cache.set(key, albumId);
    return { albumId, created };
  }

  /**
   * Tag a newly created asset without the AssetTag event (its SidecarWrite would race the metadata extraction). The
   * caller writes the returned values into the pre-extraction sidecar as TagsList and releases the tags lock.
   */
  private async tagNewAsset(run: any, settings: any, assetId: string, plan: any): Promise<string[]> {
    const vars = run.templateVars as TemplateVars;
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

  private async addTags(
    run: any,
    settings: any,
    row: any,
    assetId: string,
    plan: any,
    _isUpload: boolean,
  ): Promise<boolean> {
    const vars = run.templateVars as TemplateVars;
    const tags = dedupeTags([...(plan.tags ?? []), ...runTags(settings, vars)]);
    if (tags.length === 0) {
      return false;
    }
    const leaves = await upsertTags(this.tagRepository, { userId: run.userId, tags });
    if (leaves.length === 0) {
      return false;
    }
    await this.tagRepository.upsertAssetIds(leaves.map((t) => ({ tagId: t.id, assetId })));
    await this.eventRepository.emit('AssetTag', { assetId } as any);
    return true;
  }

  private async saveGoogleMetadata(
    run: any,
    settings: any,
    assetId: string,
    plan: any,
    alreadyProcessed: boolean,
  ): Promise<boolean> {
    if (!settings.googlePhotosFields || !plan.extra || Object.keys(plan.extra).length === 0) {
      return false;
    }
    if (alreadyProcessed) {
      // the first file of a duplicate set already wrote its extras: never overwrite them
      const existing = await this.assetRepository.getMetadataByKey(assetId, 'google-photos').catch(() => null);
      if (existing) {
        return false;
      }
    }
    const value = withGoogleAccount(plan.extra, run.templateVars as TemplateVars);
    return Promise.resolve(this.assetRepository.upsertMetadata(assetId, [{ key: 'google-photos', value }]))
      .then(() => true)
      .catch(() => false);
  }

  private async stackGroup(run: any, members: any[], allRows: any[]) {
    const ids = this.stackIds(members, allRows);
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
      for (const member of members) {
        if (member.assetId && ids.includes(member.assetId)) {
          await this.addResultFlags(member, ['stacked']);
        }
      }
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
    return links.map((seq) => {
      const linked = allRows.find((r) => r.seq === seq);
      return linked && previouslyDeletedFlags(linked).length === 0 ? (linked.assetId ?? null) : null;
    });
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
    // the detected angle turns the original into Google's edited copy clockwise, the same direction as a rotate edit
    await this.assetEditRepository.replaceAll(assetId, [
      { action: AssetEditAction.Rotate, parameters: { angle: angle % 360 } } as any,
    ]);
    await this.jobRepository.queue({ name: JobName.AssetEditThumbnailGeneration, data: { id: assetId } });
    return TakeoutRotationState.Applied;
  }
}

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

// The zone names exiftool-vendored gives a zero offset (UTC, UTC+0, Etc/UTC, GMT, Z).
const UTC_ZONE_RE = /^(?:etc\/)?(?:utc|gmt|z)(?:[+-]0{1,2}(?::00)?)?$/i;

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
  // QuickTime (MP4/MOV) dates are UTC by spec, so a video's UTC zone (defaultVideosToUTC, or a CreationDate written
  // with Z / +00:00) says nothing about where the device was.
  const isVideo = (firstString(exif.MIMEType) ?? '').toLowerCase().startsWith('video/');
  const videoUtc = isVideo && zone !== null && UTC_ZONE_RE.test(zone);
  let fileOffsetZone: string | null = null;
  const recorded =
    zoneSource.includes('offset') ||
    zoneSource.includes('timezone') ||
    zoneSource.includes('creationdate') ||
    zoneSource.includes('timecreated');
  if (zone && !zoneSource.includes('defaultvideostoutc') && !gpsDerived && !videoUtc && recorded) {
    fileOffsetZone = zone;
  }

  const fileHasGps = typeof exif.GPSLatitude === 'number' && typeof exif.GPSLongitude === 'number';
  const originalClock = exif.SubSecDateTimeOriginal ?? exif.DateTimeOriginal;
  const fileClock = exifWallClock(originalClock ?? exif.CreationDate ?? exif.CreateDate);
  // A video clock from its QuickTime dates (no DateTimeOriginal, no recorded offset) stays in UTC unless exiftool shifted
  // it into a zone (GPS): then it is the local wall clock at that place and rule 2 may use it.
  const fileClockIsUtc =
    isVideo && fileClock !== null && !originalClock && !fileOffsetZone && (zone === null || UTC_ZONE_RE.test(zone));
  const gpsDateTime = exifWallClock(exif.GPSDateTime);

  return { make, model, fileOffsetZone, fileHasGps, fileClock, fileClockIsUtc, gpsDateTime };
}

/** The reason of a server duplicate whose asset is in the trash: it never joins a stack (a trashed cover hides it) */
const IN_TRASH_REASON = 'already on the server (in trash)';
/** The reason of a smaller copy of a new file of this Takeout (same name and time, other bytes): it is not uploaded */
const LARGER_COPY_REASON = 'a larger copy with the same name and time is in this Takeout';

function nfcBase(name: string | null | undefined): string {
  return basename(name ?? '').normalize('NFC');
}

/**
 * The name + time match of DEV 5 among the files of this Takeout, like Go's ShouldUpload whose index holds the assets
 * uploaded earlier in the run. Google puts a smaller copy of a photo in an album folder ("Auto") next to the full copy
 * in its year folder. Of the planned non-edited uploads with a Google capture time, files with the same name whose
 * times are within `-5s <= smaller - larger < 5s` and whose bytes differ are copies of one photo: the largest stays an
 * upload, every other one (and each exact copy of it under the same name) maps to the key of that largest file. An
 * exact copy of the largest is left to the checksum rule. Same-name files further apart stay uploads.
 */
function largerCopiesInTakeout(files: PlannedFile[]): Map<number, number> {
  const byName = new Map<string, PlannedFile[]>();
  for (const file of files) {
    if (file.action !== 'upload' || file.isEditedCopy || !file.checksum || !file.data?.captureDate) {
      continue;
    }
    const name = nfcBase(file.onDiskName);
    const list = byName.get(name) ?? [];
    list.push(file);
    byName.set(name, list);
  }

  const largerOf = new Map<number, number>();
  for (const list of byName.values()) {
    if (list.length < 2) {
      continue;
    }
    // one entry per checksum, for its first file in plan order; the largest first (then plan order)
    const byChecksum = new Map<string, { key: number; size: number; at: number; keys: number[] }>();
    for (const file of list) {
      const hex = file.checksum!.toString('hex');
      const entry = byChecksum.get(hex);
      if (entry) {
        entry.keys.push(file.key);
      } else {
        const at = new Date(file.data!.captureDate!).getTime();
        byChecksum.set(hex, { key: file.key, size: Number(file.size), at, keys: [file.key] });
      }
    }
    const entries = byChecksum
      .values()
      .toArray()
      .sort((a, b) => b.size - a.size || a.key - b.key);
    const kept: typeof entries = [];
    for (const entry of entries) {
      const larger = kept.find((k) => entry.at - k.at >= -5000 && entry.at - k.at < 5000);
      if (larger === undefined) {
        kept.push(entry);
        continue;
      }
      for (const key of entry.keys) {
        largerOf.set(key, larger.key);
      }
    }
  }
  return largerOf;
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
