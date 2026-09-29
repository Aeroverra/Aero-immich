import { createHash } from 'node:crypto';
import { open as fsOpen, stat as fsStat } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { TakeoutCatalogStatus, TakeoutEntryKind, TakeoutSampleSkipped } from 'src/enum';
import type { TakeoutRepository } from 'src/repositories/takeout.repository';
import { Reservation, StagingStore, withTransportRetry } from 'src/services/takeout-staging';
import type { FileSourceFs } from 'src/takeout';
import {
  ArchiveChangedError,
  ArchiveDataError,
  ArchiveEntryInfo,
  ByteLease,
  ByteSemaphore,
  ChecksumSet,
  CompactGoogleJson,
  EntryDataError,
  EntryOpener,
  FileFingerprint,
  GzipIntegrityError,
  ImageSampleResult,
  PartMissingError,
  ReadMeter,
  StagingView,
  TakeoutReadStats,
  TakeoutRunPartStats,
  WalkSourceOptions,
  chooseReadMode,
  classifyEntry,
  compactGoogleJson,
  computeImageSample,
  decideAfterHash,
  decideAfterProbe,
  fingerprintOf,
  hashTap,
  hex,
  isArchiveDataError,
  isDecodable,
  isTransportError,
  messageOf,
  newReadMeter,
  pathKey,
  sameFingerprint,
  walkArchive,
} from 'src/takeout';

// The reading and fetching machinery of a run (single-pass design 6 and 8). Nothing here is a Nest service: the run
// service builds a ReadContext per attempt and drives the phases.

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;
const noop = () => {};

function envInt(name: string): number | undefined {
  const value = Math.trunc(Number(process.env[name] ?? ''));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** CATALOG_VERSION of the reader that writes takeout_entry rows; any other value means "not catalogued" */
export const CATALOG_VERSION = 2;

export interface ReadLimits {
  /** readers per run */
  readers: number;
  /** readers per process, shared by all runs, reading and fetching */
  maxReaders: number;
  readChunk: number;
  readaheadDepth: number;
  bufferLimit: number;
  sampleBufferLimit: number;
  probeBytes: number;
  jsonReadLimit: number;
  memoryBudget: number;
  /**
   * Image decode memory of the sampler: its own budget, held by decodes only, so a decode never waits for memory
   * that buffers or readahead hold (they are freed only when their samples finish). A decode larger than the budget
   * runs alone.
   */
  decodeBudget: number;
  /** blob writes in flight per process: write-behind and streamed writes alike */
  maxWritesInFlight: number;
  zipSeekGap: number;
  flushRows: number;
  flushJsonBytes: number;
  flushEntryBytes: number;
  flushIntervalMs: number;
  freeSpaceReserve: number;
  transportRetryBudgetMs: number;
  readStallMs: number;
  /** last resort: whole-part attempts after the transport budget */
  ioRetries: number[];
  cancelReaderCapMs: number;
  cancelWriteCapMs: number;
  /** test only, unset in production: throttles archive reads so E2E cancel and restart windows are reliable */
  throttleMBps: number | null;
  /** more server candidates of one size than this: the prefix probe answers "match" */
  prefixCandidates: number;
  /** a part changed within this many ms is still being copied */
  stableAgeMs: number;
}

export const DEFAULT_READ_LIMITS: ReadLimits = {
  readers: envInt('IMMICH_TAKEOUT_READERS') ?? 3,
  maxReaders: 4,
  readChunk: 4 * MiB,
  readaheadDepth: envInt('IMMICH_TAKEOUT_READAHEAD') ?? 4,
  bufferLimit: 64 * MiB,
  sampleBufferLimit: 256 * MiB,
  probeBytes: 1 * MiB,
  jsonReadLimit: 4 * MiB,
  memoryBudget: 512 * MiB,
  decodeBudget: 256 * MiB,
  maxWritesInFlight: 2,
  zipSeekGap: 8 * MiB,
  flushRows: 1000,
  flushJsonBytes: 16 * MiB,
  flushEntryBytes: 256 * MiB,
  flushIntervalMs: 2000,
  freeSpaceReserve: 5 * GiB,
  transportRetryBudgetMs: 10 * 60_000,
  readStallMs: 10 * 60_000,
  ioRetries: [5000, 30_000, 120_000],
  cancelReaderCapMs: 3000,
  cancelWriteCapMs: 2000,
  throttleMBps: envInt('IMMICH_TAKEOUT_READ_THROTTLE_MBPS') ?? null,
  prefixCandidates: 8,
  stableAgeMs: 30_000,
};

// ---------- abort reasons ----------

/** The run fails (resumable): readers stop, targets are reclaimed, staging is kept */
export class RunFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunFailure';
  }
}

export class CancelReason extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelReason';
  }
}

/** Another worker owns the run now: stop without writing anything */
export class LeaseLost extends Error {
  constructor() {
    super('lease lost');
    this.name = 'LeaseLost';
  }
}

export function asRunReason(error: unknown): Error {
  if (error instanceof RunFailure || error instanceof CancelReason || error instanceof LeaseLost) {
    return error;
  }
  return new RunFailure(messageOf(error));
}

// ---------- process-wide resources ----------

interface WriteJob {
  runId: string;
  token: ReaderToken;
  store: StagingStore;
  reservation: Reservation;
  buf: Buffer;
  lease: ByteLease | null;
  space: SpaceReservation | null;
  /** set by enqueue: resolves once the job settled (written, failed or dropped) */
  settled?: () => void;
}

/**
 * Blob writes of the process (single-pass design 6.5, 12): at most `maxInFlight` at a time, counted by one slot
 * semaphore that the write-behind of buffered entries (FIFO) and the streamed writes (large entries, tgz re-stage,
 * fetch; `acquireSlot`) share. A write-behind job never rejects: ENOSPC or a failure after the transport budget sets
 * `store.fatal` and releases everything, so no write-behind promise can go unhandled.
 */
export class WriteQueue {
  private queue: WriteJob[] = [];
  private waitingForSlot = false;
  private perRun = new Map<string, number>();
  private idleWaiters = new Map<string, Set<() => void>>();
  private readonly slots: ByteSemaphore;
  written = 0;

  constructor(
    readonly maxInFlight: number,
    private readonly retryBudgetMs: number,
    private readonly sleep?: (ms: number) => Promise<void>,
  ) {
    this.slots = new ByteSemaphore(maxInFlight);
  }

  /** most writes ever in flight at once, write-behind and streamed */
  get peakInFlight(): number {
    return this.slots.peak;
  }

  /** A write slot for a streamed write; release it once the temp file is committed or discarded */
  acquireSlot(signal?: AbortSignal): Promise<ByteLease> {
    return this.slots.acquire(1, signal);
  }

  /**
   * Queue a write-behind job. The returned promise resolves once the job settled: written, failed (`store.fatal` is
   * set) or dropped; it never rejects.
   */
  enqueue(job: WriteJob): Promise<void> {
    const settled = new Promise<void>((resolve) => {
      job.settled = resolve;
    });
    if (job.token.detached || job.store.fatal) {
      this.release(job);
      return settled;
    }
    this.perRun.set(job.runId, (this.perRun.get(job.runId) ?? 0) + 1);
    this.queue.push(job);
    this.pump();
    return settled;
  }

  pending(runId: string): number {
    return this.perRun.get(runId) ?? 0;
  }

  /** one slot request at a time for the head of the queue; each granted slot starts one job */
  private pump() {
    if (this.waitingForSlot || this.queue.length === 0) {
      return;
    }
    this.waitingForSlot = true;
    void this.slots.acquire(1).then((slot) => {
      this.waitingForSlot = false;
      const job = this.queue.shift();
      if (!job) {
        // the queued jobs were dropped meanwhile (drain)
        slot.release();
        return;
      }
      void this.run(job).finally(() => {
        slot.release();
        this.done(job.runId);
        this.pump();
      });
      this.pump();
    });
  }

  private async run(job: WriteJob): Promise<void> {
    try {
      if (job.token.detached || job.store.fatal) {
        return;
      }
      await withTransportRetry(() => job.store.writeBuffer(job.reservation, job.buf), {
        budgetMs: this.retryBudgetMs,
        sleep: this.sleep,
      });
      this.written++;
      job.space?.commit();
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      job.store.setFatal(
        code === 'ENOSPC' || code === 'EDQUOT'
          ? new RunFailure('Not enough free space')
          : new RunFailure(`Could not write to staging: ${messageOf(error)}`),
      );
    } finally {
      this.release(job);
    }
  }

  private release(job: WriteJob) {
    job.reservation.releaseIfPending();
    job.lease?.release();
    job.space?.release();
    job.settled?.();
  }

  private done(runId: string) {
    const left = (this.perRun.get(runId) ?? 1) - 1;
    if (left <= 0) {
      this.perRun.delete(runId);
      for (const resolve of this.idleWaiters.get(runId) ?? []) {
        resolve();
      }
      this.idleWaiters.delete(runId);
    } else {
      this.perRun.set(runId, left);
    }
  }

  /** Wait until the run's writes settled; with dropQueued, writes that did not start are released unwritten */
  async drain(runId: string, options: { dropQueued: boolean; capMs: number }): Promise<void> {
    if (options.dropQueued) {
      const keep: WriteJob[] = [];
      for (const job of this.queue) {
        if (job.runId === runId) {
          this.release(job);
          this.done(runId);
        } else {
          keep.push(job);
        }
      }
      this.queue = keep;
    }
    if (this.pending(runId) === 0) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const idle = new Promise<void>((resolve) => {
      const set = this.idleWaiters.get(runId) ?? new Set();
      set.add(resolve);
      this.idleWaiters.set(runId, set);
    });
    const cap =
      options.capMs === Infinity
        ? null
        : new Promise<void>((resolve) => {
            timer = setTimeout(resolve, options.capMs);
          });
    await (cap ? Promise.race([idle, cap]) : idle);
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Image samples (single-pass design 6.5): at most `concurrency` decodes, decode memory reserved before decoding.
 * Decode memory comes from its own budget (`decode`), never from the budget of buffers and readahead: a sample waits
 * there while it holds its buffer's share, and the buffers of the other pending samples and the readers' readahead
 * are freed only when samples finish, so waiting behind them could never end.
 */
export class Sampler {
  private slots: ByteSemaphore;

  constructor(
    private readonly decode: ByteSemaphore,
    concurrency = 2,
  ) {
    this.slots = new ByteSemaphore(concurrency);
  }

  /**
   * Never rejects; releases `share` (the buffer's memory) when done. Null when the read was stopped before the
   * sample was computed: the entry stays a sample backfill candidate instead of a decode error.
   */
  async sample(buf: Buffer, share: ByteLease | null, signal?: AbortSignal): Promise<ImageSampleResult | null> {
    let slot: ByteLease | null = null;
    let decode: ByteLease | null = null;
    try {
      slot = await this.slots.acquire(1, signal);
      const meta = await sharp(buf, { failOn: 'none', limitInputPixels: false })
        .metadata()
        .catch(() => null);
      const pixels = (meta?.width ?? 0) * (meta?.height ?? 0);
      if (pixels > 0 && pixels <= 268_402_689) {
        // w x h x 4; a decode larger than the budget is admitted when no other decode runs
        decode = await this.decode.acquire(Math.min(pixels * 4, this.decode.capacity), signal);
      }
      return await computeImageSample(buf);
    } catch {
      return signal?.aborted ? null : { skipped: 'decodeError' };
    } finally {
      decode?.release();
      share?.release();
      slot?.release();
    }
  }
}

export interface ProcessResources {
  memory: ByteSemaphore;
  /** image decode memory, held by the sampler's decodes only */
  decode: ByteSemaphore;
  readers: ByteSemaphore;
  writes: WriteQueue;
  sampler: Sampler;
}

let processResources: ProcessResources | null = null;

export function createProcessResources(limits: ReadLimits): ProcessResources {
  const decode = new ByteSemaphore(limits.decodeBudget);
  return {
    memory: new ByteSemaphore(limits.memoryBudget),
    decode,
    readers: new ByteSemaphore(limits.maxReaders),
    writes: new WriteQueue(limits.maxWritesInFlight, limits.transportRetryBudgetMs),
    sampler: new Sampler(decode, 2),
  };
}

/** Wait for `promise` (never rejects) at most `ms`; a promise that never settles is left behind */
export async function settleWithin(promise: Promise<unknown> | null, ms: number): Promise<void> {
  if (!promise) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([promise.then(noop).catch(noop), cap]);
  clearTimeout(timer);
}

/** `promise`, or `onTimeout()` as the rejection after `ms` (the call that never answers is left behind) */
export async function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** One memory budget, reader cap, write queue and sampler for the whole process */
export function getProcessResources(): ProcessResources {
  processResources ??= createProcessResources(DEFAULT_READ_LIMITS);
  return processResources;
}

// ---------- space and quota ----------

export interface SpaceReservation {
  commit(): void;
  release(): void;
}

/**
 * Space and quota budget of the reading phase (single-pass design 6.8): an entry that does not fit is hashed only
 * and ends 'deferred'. Reading never fails for lack of space and never runs past it.
 */
export class SpaceBudget {
  available = Infinity;
  private reservedNotOnDisk = 0;
  private writtenSinceRefresh = 0;
  stagedBytes = 0;

  constructor(
    private readonly options: {
      quotaLimit: number | null;
      quotaUsage: number;
      reserve: number;
      statfs: () => Promise<number>;
    },
  ) {}

  private refreshing: Promise<void> | null = null;

  /**
   * One statfs at a time; the budget keeps its last value until it answers. Resolves when it answered or after
   * `waitMs`: a share that stops answering holds no caller (and no second statfs is started behind the stuck one).
   */
  async refresh(waitMs = Infinity): Promise<void> {
    this.refreshing ??= this.options
      .statfs()
      .then((available) => {
        this.available = available;
        this.writtenSinceRefresh = 0;
      })
      .catch(noop)
      .finally(() => {
        this.refreshing = null;
      });
    await (waitMs === Infinity ? this.refreshing : settleWithin(this.refreshing, waitMs));
  }

  /** The progress tick: start a statfs and never wait for it */
  refreshInBackground(): void {
    void this.refresh(0);
  }

  allows(size: number): boolean {
    const spaceOk = size + this.reservedNotOnDisk + this.writtenSinceRefresh <= this.available - this.options.reserve;
    const quotaOk =
      this.options.quotaLimit === null ||
      this.options.quotaUsage + this.stagedBytes + this.reservedNotOnDisk + size <= this.options.quotaLimit;
    return spaceOk && quotaOk;
  }

  tryReserve(size: number): SpaceReservation | null {
    if (!this.allows(size)) {
      return null;
    }
    this.reservedNotOnDisk += size;
    let open = true;
    return {
      commit: () => {
        if (!open) {
          return;
        }
        open = false;
        this.reservedNotOnDisk -= size;
        this.writtenSinceRefresh += size;
        this.stagedBytes += size;
      },
      release: () => {
        if (!open) {
          return;
        }
        open = false;
        this.reservedNotOnDisk -= size;
      },
    };
  }
}

// ---------- prefix index ----------

async function readFilePrefix(path: string, bytes: number): Promise<Buffer | null> {
  const handle = await fsOpen(path, 'r').catch(() => null);
  if (!handle) {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(bytes);
    let filled = 0;
    while (filled < bytes) {
      const { bytesRead } = await handle.read(buf, filled, bytes - filled, filled);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    return buf.subarray(0, filled);
  } catch {
    return null;
  } finally {
    await handle.close().catch(noop);
  }
}

export function sha1(data: Buffer): Buffer {
  return createHash('sha1').update(data).digest();
}

/**
 * Answers "is content of this size with this first MiB present?" (single-pass design 6.2): server assets of that
 * size (their first MiB read once and cached; more than 8 candidates answer yes, which bounds the reads) and large
 * entries of this attempt whose content is committed, reserved or being streamed.
 */
export class PrefixIndex {
  private server = new Map<number, Promise<Set<string> | 'many'>>();
  private run = new Map<number, Map<string, number>>();

  constructor(
    private readonly repo: Pick<TakeoutRepository, 'getUploadAssetsBySize'>,
    private readonly userId: string,
    private readonly serverSizes: Set<number>,
    private readonly probeBytes: number,
    private readonly maxCandidates: number,
    private readonly readPrefix: (path: string, bytes: number) => Promise<Buffer | null> = readFilePrefix,
  ) {}

  async matches(size: number, prefixHash: Buffer): Promise<boolean> {
    const key = hex(prefixHash);
    if (this.run.get(size)?.has(key)) {
      return true;
    }
    if (!this.serverSizes.has(size)) {
      return false;
    }
    let cached = this.server.get(size);
    if (!cached) {
      cached = this.loadServer(size);
      this.server.set(size, cached);
    }
    const prefixes = await cached;
    return prefixes === 'many' || prefixes.has(key);
  }

  private async loadServer(size: number): Promise<Set<string> | 'many'> {
    const assets = await this.repo.getUploadAssetsBySize(this.userId, size, this.maxCandidates + 1);
    if (assets.length > this.maxCandidates) {
      return 'many';
    }
    const prefixes = new Set<string>();
    for (const asset of assets) {
      const prefix = await this.readPrefix(asset.originalPath, this.probeBytes);
      if (prefix) {
        prefixes.add(hex(sha1(prefix)));
      }
    }
    return prefixes;
  }

  /** The content is present while it is written; keep() makes it stay, dropIfNotKept() forgets it */
  markStreaming(size: number, prefixHash: Buffer): { keep(): void; dropIfNotKept(): void } {
    const key = hex(prefixHash);
    const map = this.run.get(size) ?? new Map<string, number>();
    this.run.set(size, map);
    map.set(key, (map.get(key) ?? 0) + 1);
    let kept = false;
    let done = false;
    return {
      keep: () => {
        kept = true;
      },
      dropIfNotKept: () => {
        if (done || kept) {
          return;
        }
        done = true;
        const left = (map.get(key) ?? 1) - 1;
        if (left <= 0) {
          map.delete(key);
        } else {
          map.set(key, left);
        }
      },
    };
  }
}

// ---------- read statistics ----------

export function emptyReadStats(): TakeoutReadStats {
  return {
    version: 1,
    readers: 0,
    readahead: 0,
    crossDevice: false,
    filesFound: 0,
    mediaFound: 0,
    jsonFound: 0,
    serverDuplicatesSkipped: 0,
    localDuplicatesSkipped: 0,
    stagedFiles: 0,
    stagedBytes: 0,
    deferredFiles: 0,
    deferredBytes: 0,
    wastedWriteFiles: 0,
    wastedWriteBytes: 0,
    fetchFiles: 0,
    fetchBytesTotal: 0,
    fetchBytesRead: 0,
    sampleBackfillFiles: 0,
    directoryBytesRead: 0,
    transportRetries: 0,
    etaSeconds: null,
    discardedStagedFiles: 0,
    discardedStagedBytes: 0,
    stagingBytes: 0,
    stagingExpiresAt: null,
    parts: {},
  };
}

/** Stored readStats (possibly `{}` for runs created before the upgrade) with every field defaulted */
export function normalizeReadStats(stored: unknown): TakeoutReadStats {
  const base = emptyReadStats();
  const value = (stored ?? {}) as Partial<TakeoutReadStats>;
  const out: TakeoutReadStats = { ...base, ...value, version: 1, parts: {} };
  for (const [id, part] of Object.entries(value.parts ?? {})) {
    out.parts[id] = { ...emptyPartStats(id, part.fileName ?? '', part.size ?? 0), ...part };
  }
  return out;
}

export function emptyPartStats(partId: string, fileName: string, size: number): TakeoutRunPartStats {
  return {
    partId,
    fileName,
    size,
    segment: null,
    partNumber: 0,
    status: 'pending',
    passes: 0,
    passBase: 0,
    bytesRead: 0,
    bytesSkipped: 0,
    position: 0,
    fetchBytesRead: 0,
    entries: 0,
    media: 0,
    entryErrors: 0,
    staged: 0,
    stagedBytes: 0,
    duplicates: 0,
    deferred: 0,
    transportRetries: 0,
    error: null,
    errorOffset: null,
    startedAt: null,
    finishedAt: null,
  };
}

export interface ReadPartRow {
  id: string;
  exportId: string;
  fileName: string;
  kind: string;
  isIndex: boolean;
  size: number | string | bigint;
  mtime: Date;
  segment: number | null;
  partNumber: number;
  isMissing: boolean;
  catalogStatus: string;
  catalogVersion: number | null;
  catalogSize: number | string | bigint | null;
  catalogMtime: Date | null;
  catalogError: string | null;
  lastReadRunId: string | null;
  entryCount: number | null;
}

interface FetchPass {
  ps: TakeoutRunPartStats;
  meter: ReadMeter;
  /** bytes this part's fetch was expected to read, already counted in fetchBytesTotal */
  planned: number;
  psBase: number;
}

/** Live statistics of one run attempt, seeded from the stored readStats so a restart keeps passes and start times */
export class ReadStatsTracker {
  readonly stats: TakeoutReadStats;
  /** live meters of the parts being read (bytesRead of earlier passes is in the part's base) */
  private live = new Map<
    string,
    { meter: ReadMeter; bytesBase: number; skippedBase: number; retriesBase: number; floor: number }
  >();
  private samples: Array<{ t: number; covered: number; busy: number }> = [];
  /** fetches in progress, and the bytes read by the fetches that ended */
  private fetches = new Set<FetchPass>();
  private fetchDone: number;
  private fetchSamples: Array<{ t: number; done: number }> = [];

  constructor(stored: unknown) {
    this.stats = normalizeReadStats(stored);
    this.fetchDone = this.stats.fetchBytesRead;
  }

  part(part: Pick<ReadPartRow, 'id' | 'fileName' | 'size' | 'segment' | 'partNumber'>): TakeoutRunPartStats {
    let ps = this.stats.parts[part.id];
    if (!ps) {
      ps = emptyPartStats(part.id, part.fileName, Number(part.size));
      this.stats.parts[part.id] = ps;
    }
    ps.fileName = part.fileName;
    ps.size = Number(part.size);
    ps.segment = part.segment;
    ps.partNumber = part.partNumber;
    return ps;
  }

  /**
   * A new pass over the part. tgz restarts count their covered prefix into passBase; a zip continuation keeps the
   * covered position as a floor until the reader passes it (it re-reads the directory and the last uncommitted
   * entries first), so the progress of a part never goes back.
   */
  beginPass(ps: TakeoutRunPartStats, meter: ReadMeter, restartFromZero: boolean): number {
    let grew = 0;
    if (restartFromZero && ps.position > 0) {
      ps.passBase += ps.position;
      grew = ps.position;
    }
    ps.passes++;
    ps.status = 'reading';
    ps.error = null;
    ps.errorOffset = null;
    ps.startedAt ??= new Date().toISOString();
    ps.finishedAt = null;
    this.live.set(ps.partId, {
      meter,
      bytesBase: ps.bytesRead,
      skippedBase: ps.bytesSkipped,
      retriesBase: ps.transportRetries,
      floor: restartFromZero ? 0 : ps.position,
    });
    return grew;
  }

  /** Copy the live meter into the part stats */
  sync(ps: TakeoutRunPartStats): void {
    const live = this.live.get(ps.partId);
    if (!live) {
      return;
    }
    ps.bytesRead = live.bytesBase + live.meter.bytesRead;
    ps.bytesSkipped = live.skippedBase + live.meter.bytesSkipped;
    ps.transportRetries = live.retriesBase + live.meter.transportRetries;
    ps.position = Math.min(Math.max(live.floor, live.meter.position), ps.size);
  }

  /** A fetch of the part starts; `planned` is already part of fetchBytesTotal */
  beginFetch(ps: TakeoutRunPartStats, meter: ReadMeter, planned: number): FetchPass {
    const pass: FetchPass = { ps, meter, planned, psBase: ps.fetchBytesRead };
    this.fetches.add(pass);
    return pass;
  }

  /** The fetch ended: its bytes count as read, and the total takes what it really read in place of the plan */
  endFetch(pass: FetchPass): void {
    if (!this.fetches.delete(pass)) {
      return;
    }
    const actual = pass.meter.bytesRead;
    pass.ps.fetchBytesRead = pass.psBase + actual;
    this.fetchDone += actual;
    this.stats.fetchBytesTotal = Math.max(0, this.stats.fetchBytesTotal + actual - pass.planned);
    this.syncFetch();
  }

  /**
   * The live fetch bytes: a fetch in progress counts at most what it planned (the zip directory and the readahead
   * past the last entry would pass it), so fetchBytesRead never exceeds fetchBytesTotal and both meet at the end
   */
  syncFetch(): void {
    let live = 0;
    for (const pass of this.fetches) {
      pass.ps.fetchBytesRead = pass.psBase + pass.meter.bytesRead;
      live += Math.min(pass.meter.bytesRead, pass.planned);
    }
    this.stats.fetchBytesRead = this.fetchDone + live;
  }

  /** remaining fetch bytes / fetch rate of the last two minutes */
  fetchEta(now = Date.now()): number | null {
    this.syncFetch();
    const done = this.stats.fetchBytesRead;
    this.fetchSamples.push({ t: now, done });
    while (this.fetchSamples.length > 0 && now - this.fetchSamples[0].t > 120_000) {
      this.fetchSamples.shift();
    }
    const first = this.fetchSamples[0];
    const seconds = (now - first.t) / 1000;
    if (seconds < 5 || done <= first.done) {
      return null;
    }
    const rate = (done - first.done) / seconds;
    return Math.max(0, Math.round(Math.max(0, this.stats.fetchBytesTotal - done) / rate));
  }

  endPass(ps: TakeoutRunPartStats): void {
    this.sync(ps);
    this.live.delete(ps.partId);
  }

  finish(ps: TakeoutRunPartStats, status: 'read' | 'error' | 'cached' | 'missing', error?: unknown): void {
    this.endPass(ps);
    ps.status = status;
    ps.position = ps.size;
    ps.finishedAt = new Date().toISOString();
    if (error !== undefined) {
      ps.error = messageOf(error);
      ps.errorOffset = (error as { byteOffset?: number | null }).byteOffset ?? null;
    }
  }

  /** The live meters (stall watchdog) */
  meters(): Array<{ partId: string; meter: ReadMeter }> {
    return [...this.live].map(([partId, value]) => ({ partId, meter: value.meter }));
  }

  /** Sum of passBase + position of the parts this run read: monotonic across restarts */
  covered(): number {
    let sum = 0;
    for (const ps of Object.values(this.stats.parts)) {
      this.sync(ps);
      if (ps.passes > 0) {
        sum += ps.passBase + ps.position;
      }
    }
    return sum;
  }

  transportRetries(): number {
    let sum = 0;
    for (const ps of Object.values(this.stats.parts)) {
      sum += ps.transportRetries;
    }
    return sum;
  }

  /** remaining / (per-reader rate x min(readers, parts left)), from the bytes covered in the last two minutes */
  eta(total: number, readers: number, now = Date.now()): number | null {
    const covered = this.covered();
    const busy = this.live.size;
    this.samples.push({ t: now, covered, busy });
    while (this.samples.length > 0 && now - this.samples[0].t > 120_000) {
      this.samples.shift();
    }
    const first = this.samples[0];
    const seconds = (now - first.t) / 1000;
    const avgBusy = this.samples.reduce((sum, s) => sum + s.busy, 0) / this.samples.length;
    if (seconds < 5 || avgBusy <= 0 || covered <= first.covered) {
      return null;
    }
    const perReader = (covered - first.covered) / seconds / avgBusy;
    const partsLeft = Object.values(this.stats.parts).filter(
      (ps) => ps.status === 'reading' || ps.status === 'pending',
    ).length;
    const parallel = Math.max(1, Math.min(readers, partsLeft));
    return Math.max(0, Math.round(Math.max(0, total - covered) / (perReader * parallel)));
  }
}

/**
 * A run stopped (failed or cancelled) while parts were being read: they are not being read any more. They show as
 * waiting (a Resume continues them) with the time the reading stopped, so the parts table neither shows a live
 * progress bar nor a read speed that keeps falling after the stop.
 */
export function stopLiveParts(stats: TakeoutReadStats, at = new Date().toISOString()): TakeoutReadStats {
  for (const ps of Object.values(stats.parts)) {
    if (ps.status !== 'reading') {
      continue;
    }
    ps.status = 'pending';
    ps.finishedAt = at;
  }
  stats.etaSeconds = null;
  return stats;
}

/** One committed catalog row, as planning streams it */
export interface RecountEntry {
  partId: string;
  kind: string;
  size: number;
  checksum: Buffer | null;
  readError: string | null;
}

/**
 * Exact file counters of the parts this run read, from their committed catalog rows (called by planning).
 *
 * While parts are read the counters are live estimates, persisted every 2 s: a restart or a cancel loses the counts
 * of entries committed after the last progress write, and entries that are read again after it are counted twice
 * (a tgz part read again from byte 0 finds some of its own blobs and counts them as "seen earlier"). The recount
 * classifies every media entry of those parts once, in part order: already on the server, the same content earlier
 * in these parts, staged (its blob is present) or not staged. The I/O figures (bytes, passes, retries, wasted writes,
 * fetches) stay as measured, and `deferredFiles`/`deferredBytes` are recounted from the plan by the caller.
 */
export function recountReadStats(
  stats: TakeoutReadStats,
  entries: Iterable<RecountEntry>,
  view: { onServer: (checksum: Buffer) => boolean; hasBlob: (hex: string) => boolean },
): void {
  const parts = new Map<string, TakeoutRunPartStats>();
  for (const ps of Object.values(stats.parts)) {
    if (ps.passes === 0) {
      continue;
    }
    Object.assign(ps, { entries: 0, media: 0, entryErrors: 0, staged: 0, stagedBytes: 0, duplicates: 0, deferred: 0 });
    parts.set(ps.partId, ps);
  }
  if (parts.size === 0) {
    return;
  }
  const totals = { files: 0, media: 0, json: 0, server: 0, local: 0, staged: 0, stagedBytes: 0 };
  const seen = new Set<string>();
  for (const entry of entries) {
    const ps = parts.get(entry.partId);
    if (!ps) {
      continue;
    }
    ps.entries++;
    totals.files++;
    if (entry.readError) {
      ps.entryErrors++;
      continue;
    }
    if (entry.kind === 'json') {
      totals.json++;
    }
    if (entry.kind !== 'media') {
      continue;
    }
    ps.media++;
    totals.media++;
    if (!entry.checksum) {
      continue;
    }
    const key = hex(entry.checksum);
    if (view.onServer(entry.checksum)) {
      ps.duplicates++;
      totals.server++;
    } else if (seen.has(key)) {
      ps.duplicates++;
      totals.local++;
    } else if (view.hasBlob(key)) {
      ps.staged++;
      ps.stagedBytes += entry.size;
      totals.staged++;
      totals.stagedBytes += entry.size;
    } else {
      ps.deferred++;
    }
    seen.add(key);
  }
  stats.filesFound = totals.files;
  stats.mediaFound = totals.media;
  stats.jsonFound = totals.json;
  stats.serverDuplicatesSkipped = totals.server;
  stats.localDuplicatesSkipped = totals.local;
  stats.stagedFiles = totals.staged;
  stats.stagedBytes = totals.stagedBytes;
}

// ---------- the read context ----------

export interface ReaderToken {
  detached: boolean;
}

export interface ReadDeps {
  repo: TakeoutRepository;
  logger: { log(message: string): void; warn(message: string): void; error(message: string): void };
  /** fault injection for the archive files */
  fs?: FileSourceFs;
}

export interface ReadRunRow {
  id: string;
  userId: string;
  exportId: string;
  readStats: unknown;
}

export interface ReadContextInit {
  run: ReadRunRow;
  deps: ReadDeps;
  limits: ReadLimits;
  resources: ProcessResources;
  staging: StagingStore;
  stats: ReadStatsTracker;
  partPath: (fileName: string) => string;
  signal: AbortSignal;
}

export class ReadContext {
  readonly run: ReadRunRow;
  readonly deps: ReadDeps;
  readonly limits: ReadLimits;
  readonly resources: ProcessResources;
  readonly staging: StagingStore;
  readonly stats: ReadStatsTracker;
  readonly partPath: (fileName: string) => string;
  /** aborted by the run signal (cancel, lease loss), the first reader failure and the stall watchdog */
  readonly readAbort = new AbortController();
  server: ChecksumSet = ChecksumSet.empty();
  private serverReady = false;
  serverSizes = new Set<number>();
  prefixes: PrefixIndex;
  sampleSet: Set<string> | 'all' = 'all';
  budget: SpaceBudget = new SpaceBudget({
    quotaLimit: null,
    quotaUsage: 0,
    reserve: 0,
    statfs: () => Promise.resolve(Infinity),
  });
  readonly missingThisAttempt = new Set<string>();
  /** covered prefixes of tgz parts restarted from byte 0 in this attempt: archiveBytesTotal grows by them */
  archiveTotalGrowth = 0;
  readonly view: StagingView;
  private readonly unlinkRunSignal: () => void;
  /** meters of the reads outside the reading passes, by the name the stall message shows */
  private readonly watched = new Map<ReadMeter, string>();

  constructor(init: ReadContextInit) {
    this.run = init.run;
    this.deps = init.deps;
    this.limits = init.limits;
    this.resources = init.resources;
    this.staging = init.staging;
    this.stats = init.stats;
    this.partPath = init.partPath;
    this.prefixes = new PrefixIndex(
      init.deps.repo,
      init.run.userId,
      this.serverSizes,
      init.limits.probeBytes,
      init.limits.prefixCandidates,
    );
    this.view = {
      onServer: (checksum) => this.server.has(checksum),
      hasBlobOrReserved: (h) => this.staging.hasBlobOrReserved(h),
      budgetAllows: (size) => this.budget.allows(size),
      limits: { bufferLimit: init.limits.bufferLimit, sampleBufferLimit: init.limits.sampleBufferLimit },
    };
    const onRunAbort = () => this.readAbort.abort(init.signal.reason);
    if (init.signal.aborted) {
      onRunAbort();
    }
    init.signal.addEventListener('abort', onRunAbort, { once: true });
    this.unlinkRunSignal = () => init.signal.removeEventListener('abort', onRunAbort);
  }

  /** The server snapshot, sizes, prefix index and budget of the reading phase (single-pass design 6.3) */
  async prepareReading(options: {
    deletedSkip: boolean;
    quotaLimit: number | null;
    quotaUsage: number;
    statfs: () => Promise<number>;
    serverChecksums?: AsyncIterable<Buffer | null>;
  }): Promise<void> {
    const repo = this.deps.repo;
    const run = this.run;
    this.server = await ChecksumSet.fromAsync(options.serverChecksums ?? this.serverChecksums(options.deletedSkip));
    this.serverReady = true;
    this.serverSizes = new Set(await repo.getUploadAssetSizesOver(run.userId, this.limits.bufferLimit));
    this.prefixes = new PrefixIndex(
      repo,
      run.userId,
      this.serverSizes,
      this.limits.probeBytes,
      this.limits.prefixCandidates,
    );
    this.budget = new SpaceBudget({
      quotaLimit: options.quotaLimit,
      quotaUsage: options.quotaUsage,
      reserve: this.limits.freeSpaceReserve,
      statfs: options.statfs,
    });
    await this.budget.refresh(this.limits.readStallMs);
  }

  /** The user's upload checksums (trashed included), plus the deleted ones when re-imports of those are skipped */
  private async *serverChecksums(deletedSkip: boolean): AsyncIterable<Buffer | null> {
    for await (const row of this.deps.repo.streamUploadChecksums(this.run.userId)) {
      yield row.checksum;
    }
    if (deletedSkip) {
      for await (const row of this.deps.repo.streamDeletedChecksums(this.run.userId)) {
        yield row.checksum;
      }
    }
  }

  /** The server snapshot of this attempt; built here when the attempt read nothing (planning after a restart) */
  async serverSet(deletedSkip: boolean): Promise<ChecksumSet> {
    if (!this.serverReady) {
      this.server = await ChecksumSet.fromAsync(this.serverChecksums(deletedSkip));
      this.serverReady = true;
    }
    return this.server;
  }

  sourceOptions(): WalkSourceOptions {
    return {
      chunk: this.limits.readChunk,
      depth: this.limits.readaheadDepth,
      retryBudgetMs: this.limits.transportRetryBudgetMs,
      memory: this.resources.memory,
      fs: this.deps.fs,
    };
  }

  /**
   * Put the meter of a read outside the reading passes (fetch, sample backfill, zip directories, the index) under
   * the stall watchdog; call the returned function when the read ended
   */
  watch(name: string, meter: ReadMeter): () => void {
    this.watched.set(meter, name);
    return () => this.watched.delete(meter);
  }

  /** Every progress tick: a read pending longer than READ_STALL_MS fails the run (resumable) */
  checkStall(now = Date.now()): void {
    const meters = [
      ...this.stats
        .meters()
        .map(({ partId, meter }) => ({ name: this.stats.stats.parts[partId]?.fileName ?? partId, meter })),
      ...[...this.watched].map(([meter, name]) => ({ name, meter })),
    ];
    for (const { name, meter } of meters) {
      if (meter.pendingSince === null || !(now - meter.pendingSince > this.limits.readStallMs)) {
        continue;
      }
      const minutes = Math.round(this.limits.readStallMs / 60_000);
      this.readAbort.abort(
        new RunFailure(`Reading ${name} stalled for ${minutes} min (the archive share does not answer)`),
      );
    }
  }

  dispose(): void {
    this.unlinkRunSignal();
  }
}

// ---------- helpers ----------

/** stat -> in-run fingerprint; null when the file is gone; transport errors are retried, then a RunFailure */
export async function statFingerprint(path: string, limits: ReadLimits): Promise<FileFingerprint | null> {
  try {
    const st = await withTransportRetry(() => fsStat(path), { budgetMs: limits.transportRetryBudgetMs });
    return fingerprintOf(st);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return null;
    }
    throw new RunFailure(`Could not read ${path}: ${messageOf(error)}`);
  }
}

export function isStableNow(st: FileFingerprint, limits: ReadLimits, now = Date.now()): boolean {
  return now - st.ctimeMs >= limits.stableAgeMs;
}

/** The persisted cache key (D-7): catalog version, size and mtime; ctime and inode are checked within a run only */
export function keyEqual(part: ReadPartRow, st: FileFingerprint): boolean {
  return (
    part.catalogVersion === CATALOG_VERSION &&
    part.catalogSize !== null &&
    Number(part.catalogSize) === st.size &&
    part.catalogMtime !== null &&
    new Date(part.catalogMtime).getTime() === mtimeDate(st).getTime()
  );
}

/** The mtime as node's stat() Date gives it (rounded to the millisecond), which is what folder sync stores */
export function mtimeDate(st: FileFingerprint): Date {
  return new Date(Math.round(st.mtimeMs));
}

export function catalogUsable(part: ReadPartRow, st: FileFingerprint): boolean {
  return part.catalogStatus === TakeoutCatalogStatus.Complete && keyEqual(part, st);
}

/** An exact-size buffer, hashed chunk by chunk (no synchronous hash of a whole entry, no chunk pinning) */
export async function readFully(
  stream: NodeJS.ReadableStream,
  size: number,
): Promise<{ buf: Buffer; checksum: Buffer }> {
  const buf = Buffer.allocUnsafe(size);
  const hash = createHash('sha1');
  let filled = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (filled + chunk.length > size) {
      throw new EntryDataError(`entry is longer than its ${size} bytes`);
    }
    chunk.copy(buf, filled);
    hash.update(chunk);
    filled += chunk.length;
  }
  if (filled !== size) {
    throw new EntryDataError(`entry ended after ${filled} of ${size} bytes`);
  }
  return { buf, checksum: hash.digest() };
}

export async function hashStream(stream: NodeJS.ReadableStream, prefix?: Buffer): Promise<Buffer> {
  const tap = hashTap();
  const source = prefix
    ? Readable.from(
        (async function* () {
          yield prefix;
          for await (const chunk of stream as AsyncIterable<Buffer>) {
            yield chunk;
          }
        })(),
      )
    : (stream as Readable);
  await pipeline(source, tap.stream, new Writable({ write: (_c, _e, cb) => cb() }));
  return tap.result().checksum;
}

/** The first `bytes` of a stream, and a stream of the rest (nothing is lost, nothing is read twice) */
export async function readPrefix(
  stream: NodeJS.ReadableStream,
  bytes: number,
): Promise<{ prefix: Buffer; rest: Readable }> {
  const iterator = (stream as Readable)[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const chunks: Buffer[] = [];
  let total = 0;
  let ended = false;
  while (total < bytes) {
    const { value, done } = await iterator.next();
    if (done) {
      ended = true;
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const all = Buffer.concat(chunks);
  const prefix = Buffer.from(all.subarray(0, Math.min(bytes, all.length)));
  const leftover = all.length > bytes ? all.subarray(bytes) : null;
  const rest = Readable.from(
    (async function* () {
      if (leftover) {
        yield leftover;
      }
      if (ended) {
        return;
      }
      for (;;) {
        const { value, done } = await iterator.next();
        if (done) {
          return;
        }
        yield value;
      }
    })(),
  );
  rest.once('close', () => {
    void iterator.return?.();
  });
  return { prefix, rest };
}

// ---------- entry rows ----------

export interface EntryRow {
  exportId: string;
  partId: string;
  seq: number;
  path: string;
  size: number;
  mtime: Date | null;
  kind: TakeoutEntryKind;
  checksum: Buffer | null;
  json: object | null;
  jsonError: string | null;
  readError: string | null;
  width: number | null;
  height: number | null;
  sample: Buffer | null;
  sampleSkipped: string | null;
  endOffset: number | null;
  /** sample being computed (null result: not computed, the read was stopped); applied before the row is flushed */
  pendingSample?: Promise<ImageSampleResult | null> | null;
}

function toInsertable(row: EntryRow) {
  const { pendingSample: _pendingSample, ...rest } = row;
  return rest as Omit<EntryRow, 'pendingSample'> as any;
}

async function applyPendingSample(row: EntryRow): Promise<void> {
  if (!row.pendingSample) {
    return;
  }
  const result = await row.pendingSample;
  row.pendingSample = null;
  if (!result) {
    // not computed (the read was stopped): no sample and no sampleSkipped, so sample backfill tries it again
    return;
  }
  if ('skipped' in result) {
    row.sampleSkipped = result.skipped;
  } else {
    row.width = result.width;
    row.height = result.height;
    row.sample = result.sample;
  }
}

/**
 * Entry rows of one part, flushed in the background (single-pass design 6.5): at 1000 rows, 16 MiB of JSON, 256 MiB
 * of entry data or 2 s. At most one flush is outstanding; a full batch waits for it (backpressure). A flush waits
 * for the samples of its rows, never for their blob writes. Rows go in with ON CONFLICT DO NOTHING; a failed batch
 * is retried row by row, and a row that still fails is stored without its JSON (jsonError).
 */
export class EntryBatch {
  private rows: EntryRow[] = [];
  private jsonBytes = 0;
  private entryBytes = 0;
  private lastFlush = Date.now();
  private outstanding: Promise<void> | null = null;
  private error: unknown = null;
  count = 0;

  constructor(
    private readonly ctx: ReadContext,
    private readonly token: ReaderToken,
  ) {}

  async push(row: EntryRow): Promise<void> {
    this.throwIfFailed();
    this.rows.push(row);
    this.count++;
    this.entryBytes += row.size;
    if (row.json) {
      this.jsonBytes += JSON.stringify(row.json).length;
    }
    const limits = this.ctx.limits;
    const full =
      this.rows.length >= limits.flushRows ||
      this.jsonBytes >= limits.flushJsonBytes ||
      this.entryBytes >= limits.flushEntryBytes ||
      Date.now() - this.lastFlush >= limits.flushIntervalMs;
    if (!full) {
      return;
    }
    if (this.outstanding) {
      await this.outstanding;
      this.throwIfFailed();
    }
    this.startFlush();
  }

  private throwIfFailed() {
    if (this.error) {
      throw this.error;
    }
  }

  private startFlush() {
    const rows = this.rows;
    this.rows = [];
    this.jsonBytes = 0;
    this.entryBytes = 0;
    this.lastFlush = Date.now();
    const flushing: Promise<void> = this.flushRows(rows)
      .catch((error: unknown) => {
        this.error ??= error;
      })
      .finally(() => {
        if (this.outstanding === flushing) {
          this.outstanding = null;
        }
      });
    this.outstanding = flushing;
  }

  private async flushRows(rows: EntryRow[]): Promise<void> {
    for (const row of rows) {
      await applyPendingSample(row);
    }
    if (this.token.detached || rows.length === 0) {
      return;
    }
    const repo = this.ctx.deps.repo;
    try {
      await repo.insertEntries(rows.map((row) => toInsertable(row)));
    } catch {
      for (const row of rows) {
        try {
          await repo.insertEntry(toInsertable(row));
        } catch (rowError) {
          // for example a \u0000 that jsonb refuses: keep the row without its JSON
          await repo.insertEntry({ ...toInsertable(row), json: null, jsonError: messageOf(rowError) });
        }
      }
    }
  }

  /** The last rows and `commit` (the part state) in one transaction */
  async finish(commit: (rows: any[]) => Promise<void>): Promise<void> {
    if (this.outstanding) {
      await this.outstanding;
    }
    this.throwIfFailed();
    const rows = this.rows;
    this.rows = [];
    for (const row of rows) {
      await applyPendingSample(row);
    }
    if (this.token.detached) {
      return;
    }
    // every entry of the part was read: a stop that came meanwhile only left samples uncomputed, and those rows keep
    // no sample and no sampleSkipped, so sample backfill fetches them; the part is a correct cache and commits
    try {
      await commit(rows.map((row) => toInsertable(row)));
    } catch (error) {
      // the multi-row insert failed inside the transaction: store the rows one by one, then commit the part alone
      if (rows.length === 0) {
        throw error;
      }
      await this.flushRows(rows);
      await commit([]);
    }
  }

  /** On failure: outstanding and pending rows are flushed (valid rows help the resume), unless detached */
  async settle(): Promise<void> {
    if (this.outstanding) {
      await this.outstanding.catch(noop);
    }
    const rows = this.rows;
    this.rows = [];
    try {
      await this.flushRows(rows);
    } catch (error) {
      this.ctx.deps.logger.warn(`Takeout: could not store ${rows.length} entry rows: ${messageOf(error)}`);
    }
  }
}

// ---------- reading one part ----------

type ResumeMode =
  | { mode: 'fresh' }
  | { mode: 'zipFrom'; seq: number }
  | { mode: 'tgzSkip'; cached: Map<number, { path: string; size: number; kind: string; checksum: Buffer | null }> };

function newEntryRow(part: ReadPartRow, info: ArchiveEntryInfo): EntryRow {
  return {
    exportId: part.exportId,
    partId: part.id,
    seq: info.seq,
    path: info.path,
    size: info.size,
    mtime: info.mtime,
    kind: classifyEntry(info.path) as TakeoutEntryKind,
    checksum: null,
    json: null,
    jsonError: null,
    readError: null,
    width: null,
    height: null,
    sample: null,
    sampleSkipped: null,
    endOffset: info.endOffset,
    pendingSample: null,
  };
}

export function errorRow(part: ReadPartRow, info: ArchiveEntryInfo, message: string): EntryRow {
  return { ...newEntryRow(part, info), kind: TakeoutEntryKind.Other, readError: message };
}

async function readJsonInto(row: EntryRow, open: EntryOpener, size: number, limit: number): Promise<void> {
  if (size > limit) {
    row.jsonError = 'json too large';
    return;
  }
  const { buf } = await readFully(await open(), size);
  try {
    const text = buf.toString('utf8');
    row.json = text.includes('immich-go version:')
      ? { immichGo: true }
      : (compactGoogleJson(JSON.parse(text)) as CompactGoogleJson as object);
  } catch (error) {
    row.jsonError = messageOf(error);
  }
}

type Decision = 'serverDuplicate' | 'stagedDuplicate' | 'deferred' | 'stage';

function count(ctx: ReadContext, ps: TakeoutRunPartStats, decision: Decision, size: number) {
  const s = ctx.stats.stats;
  switch (decision) {
    case 'serverDuplicate': {
      s.serverDuplicatesSkipped++;
      ps.duplicates++;
      break;
    }
    case 'stagedDuplicate': {
      s.localDuplicatesSkipped++;
      ps.duplicates++;
      break;
    }
    case 'deferred': {
      s.deferredFiles++;
      s.deferredBytes += size;
      ps.deferred++;
      break;
    }
    case 'stage': {
      s.stagedFiles++;
      s.stagedBytes += size;
      ps.staged++;
      ps.stagedBytes += size;
      break;
    }
  }
}

/** One new entry: hash it, decide, stage it (single-pass design 6.5) */
export async function handleNewEntry(
  ctx: ReadContext,
  part: ReadPartRow,
  ps: TakeoutRunPartStats,
  token: ReaderToken,
  info: ArchiveEntryInfo,
  open: EntryOpener,
  /** the write-behind jobs of the part being read, until they settled */
  partWrites?: Set<Promise<void>>,
): Promise<EntryRow> {
  const row = newEntryRow(part, info);
  const signal = ctx.readAbort.signal;
  ctx.stats.stats.filesFound++;
  ps.entries++;
  if (info.error) {
    row.kind = TakeoutEntryKind.Other;
    row.readError = info.error;
    ps.entryErrors++;
    return row;
  }
  try {
    if (row.kind === TakeoutEntryKind.Json) {
      ctx.stats.stats.jsonFound++;
      await readJsonInto(row, open, info.size, ctx.limits.jsonReadLimit);
      return row;
    }
    if (row.kind !== TakeoutEntryKind.Media) {
      return row;
    }
    ctx.stats.stats.mediaFound++;
    ps.media++;
    const wantSample = ctx.sampleSet === 'all' ? isDecodable(info.path) : ctx.sampleSet.has(pathKey(info.path));
    let mode = chooseReadMode(info.size, wantSample, ctx.view);

    if (mode === 'buffer') {
      const lease = await ctx.resources.memory.acquire(info.size, signal);
      try {
        const { buf, checksum } = await readFully(await open(), info.size);
        row.checksum = checksum;
        if (wantSample) {
          row.pendingSample = ctx.resources.sampler.sample(buf, lease.share(), signal);
        }
        let decision: Decision = decideAfterHash(checksum, info.size, 'buffer', ctx.view);
        let space: SpaceReservation | null = null;
        if (decision === 'stage') {
          space = ctx.budget.tryReserve(info.size);
          if (!space) {
            decision = 'deferred';
          }
        }
        const reservation = decision === 'stage' ? ctx.staging.reserve(hex(checksum)) : null;
        if (decision === 'stage' && !reservation) {
          // lost a race with another reader
          space?.release();
          space = null;
          decision = 'stagedDuplicate';
        }
        count(ctx, ps, decision, info.size);
        if (reservation) {
          const settled = ctx.resources.writes.enqueue({
            runId: ctx.run.id,
            token,
            store: ctx.staging,
            reservation,
            buf,
            lease: lease.share(),
            space,
          });
          if (partWrites) {
            partWrites.add(settled);
            void settled.then(() => partWrites.delete(settled));
          }
        }
      } finally {
        lease.release();
      }
      return row;
    }

    let space: SpaceReservation | null = null;
    if (mode === 'probe') {
      space = ctx.budget.tryReserve(info.size);
      if (!space) {
        mode = 'hashOnly';
      }
    }

    if (mode === 'probe') {
      try {
        const { prefix, rest } = await readPrefix(await open(), ctx.limits.probeBytes);
        const prefixHash = sha1(prefix);
        const streamMode = decideAfterProbe(await ctx.prefixes.matches(info.size, prefixHash));
        if (streamMode === 'stream') {
          const present = ctx.prefixes.markStreaming(info.size, prefixHash);
          let tmp: string | null = null;
          let slot: ByteLease | null = null;
          try {
            slot = await ctx.resources.writes.acquireSlot(signal);
            const written = await ctx.staging.streamToTemp(rest, prefix);
            tmp = written.tmp;
            row.checksum = written.checksum;
            const decision = decideAfterHash(written.checksum, info.size, 'stream', ctx.view);
            const reservation = decision === 'stage' ? ctx.staging.reserve(hex(written.checksum)) : null;
            if (reservation) {
              try {
                await ctx.staging.commitTemp(written.tmp, reservation, written.size);
              } finally {
                reservation.releaseIfPending();
              }
              tmp = null;
              present.keep();
              space?.commit();
              count(ctx, ps, 'stage', info.size);
            } else {
              await ctx.staging.discardTemp(written.tmp);
              tmp = null;
              ctx.stats.stats.wastedWriteFiles++;
              ctx.stats.stats.wastedWriteBytes += info.size;
              count(ctx, ps, decision === 'stage' ? 'stagedDuplicate' : decision, info.size);
            }
          } finally {
            if (tmp) {
              await ctx.staging.discardTemp(tmp);
            }
            slot?.release();
            present.dropIfNotKept();
          }
        } else {
          row.checksum = await hashStream(rest, prefix);
          count(ctx, ps, decideAfterHash(row.checksum, info.size, 'hashOnly', ctx.view), info.size);
        }
      } finally {
        space?.release();
      }
    } else {
      row.checksum = await hashStream(await open());
      count(ctx, ps, decideAfterHash(row.checksum, info.size, 'hashOnly', ctx.view), info.size);
    }
    if (wantSample) {
      row.sampleSkipped = 'tooLarge';
    }
    return row;
  } catch (error) {
    if (error instanceof EntryDataError && part.kind === 'zip') {
      // local header, inflate, length or CRC-32: this entry only; the walker continues
      row.kind = TakeoutEntryKind.Other;
      row.checksum = null;
      row.json = null;
      row.readError = messageOf(error);
      row.pendingSample = null;
      ps.entryErrors++;
      return row;
    }
    throw error;
  }
}

/** tgz resume only: the bytes pass by anyway; only a lost blob is written again (single-pass design 6.5) */
export async function handleCachedEntry(
  ctx: ReadContext,
  cached: { path: string; size: number; kind: string; checksum: Buffer | null },
  info: ArchiveEntryInfo,
  open: EntryOpener,
): Promise<void> {
  if (cached.path !== info.path || cached.size !== info.size) {
    throw new ArchiveChangedError(`${info.path} is not what an earlier read of this part found`);
  }
  if (cached.kind !== TakeoutEntryKind.Media || !cached.checksum) {
    return;
  }
  const h = hex(cached.checksum);
  if (ctx.server.has(cached.checksum)) {
    return;
  }
  if (ctx.staging.hasBlob(h) && (await ctx.staging.hasBlobWithSize(h, cached.size))) {
    return;
  }
  const space = ctx.budget.tryReserve(cached.size);
  if (!space) {
    return;
  }
  const reservation = ctx.staging.reserve(h);
  if (!reservation) {
    space.release();
    return;
  }
  let slot: ByteLease | null = null;
  try {
    slot = await ctx.resources.writes.acquireSlot(ctx.readAbort.signal);
    const written = await ctx.staging.streamToTemp(await open());
    if (!written.checksum.equals(cached.checksum)) {
      await ctx.staging.discardTemp(written.tmp);
      throw new ArchiveChangedError(`${info.path} changed since an earlier read of this part`);
    }
    await ctx.staging.commitTemp(written.tmp, reservation, written.size);
    space.commit();
  } finally {
    slot?.release();
    reservation.releaseIfPending();
    space.release();
  }
}

/** Read one part once: hash, decide, stage, entry rows (single-pass design 6.5) */
export async function readPart(
  ctx: ReadContext,
  part: ReadPartRow,
  st: FileFingerprint,
  token: ReaderToken,
): Promise<void> {
  const repo = ctx.deps.repo;
  const ps = ctx.stats.part(part);
  const kind = part.kind === 'zip' ? 'zip' : 'tgz';

  // 1. resume point (persisted key: catalogVersion, catalogSize, catalogMtime)
  let resume: ResumeMode = { mode: 'fresh' };
  const sameFile = keyEqual(part, st);
  if (
    sameFile &&
    (part.catalogStatus === TakeoutCatalogStatus.Partial || part.catalogStatus === TakeoutCatalogStatus.Reading)
  ) {
    const maxSeq = await repo.getMaxEntrySeq(part.id);
    if (maxSeq !== null) {
      resume =
        kind === 'zip'
          ? { mode: 'zipFrom', seq: maxSeq + 1 }
          : { mode: 'tgzSkip', cached: await repo.getEntriesForSkip(part.id) };
    }
  } else {
    await repo.deleteEntriesOfPart(part.id);
  }
  await repo.updatePart(part.id, {
    catalogStatus: TakeoutCatalogStatus.Reading,
    catalogVersion: CATALOG_VERSION,
    catalogSize: st.size,
    catalogMtime: mtimeDate(st),
    catalogError: null,
    catalogErrorOffset: null,
    lastReadRunId: ctx.run.id,
  });
  part.catalogStatus = TakeoutCatalogStatus.Reading;
  part.catalogVersion = CATALOG_VERSION;
  part.catalogSize = st.size;
  part.catalogMtime = mtimeDate(st);

  const meter = newReadMeter();
  // tgz always restarts from byte 0; zip does unless it resumes after its last committed entry
  ctx.archiveTotalGrowth += ctx.stats.beginPass(ps, meter, resume.mode !== 'zipFrom');
  if (resume.mode === 'fresh') {
    ps.entries = 0;
    ps.media = 0;
    ps.entryErrors = 0;
  }

  // 2. walk
  const batch = new EntryBatch(ctx, token);
  const pendingRows = new Map<number, EntryRow>();
  const partWrites = new Set<Promise<void>>();
  let inFlight: ArchiveEntryInfo | null = null;
  try {
    const result = await walkArchive(
      ctx.partPath(part.fileName),
      kind,
      async (info, open) => {
        inFlight = info;
        if (ctx.staging.fatal) {
          throw new RunFailure(messageOf(ctx.staging.fatal));
        }
        if (token.detached) {
          throw new RunFailure('reader detached');
        }
        const cached = resume.mode === 'tgzSkip' ? resume.cached.get(info.seq) : undefined;
        if (cached) {
          await handleCachedEntry(ctx, cached, info, open);
          return;
        }
        pendingRows.set(info.seq, await handleNewEntry(ctx, part, ps, token, info, open, partWrites));
      },
      {
        signal: ctx.readAbort.signal,
        fingerprint: st,
        source: ctx.sourceOptions(),
        meter,
        startSeq: resume.mode === 'zipFrom' ? resume.seq : undefined,
        zipSeekGap: ctx.limits.zipSeekGap,
        throttleMBps: ctx.limits.throttleMBps,
        afterEntry: async (info, endOffset) => {
          inFlight = null;
          const row = pendingRows.get(info.seq);
          if (row) {
            pendingRows.delete(info.seq);
            row.endOffset = endOffset;
            await batch.push(row);
          }
        },
      },
    );
    const end = await statFingerprint(ctx.partPath(part.fileName), ctx.limits);
    if (!end || !sameFingerprint(st, end)) {
      throw new ArchiveChangedError();
    }
    if (kind === 'tgz' && !result.trailerVerified) {
      throw new ArchiveDataError('the gzip stream ended without its trailer', meter.position);
    }
    // 'complete' means every row and every blob of the part is on disk: the blobs still in the write-behind queue
    // are written first, so a crash after this point never leaves a complete part whose staged files have to be
    // fetched again (for tgz that is a walk of the whole part)
    await Promise.all(partWrites);
    if (ctx.staging.fatal) {
      throw new RunFailure(messageOf(ctx.staging.fatal));
    }
    if (ctx.readAbort.signal.aborted) {
      throw asRunReason(ctx.readAbort.signal.reason);
    }
    if (token.detached) {
      throw new RunFailure('reader detached');
    }
    ctx.stats.sync(ps);
    await batch.finish((rows) => repo.completePart(part.id, rows, { bytesRead: ps.bytesRead }));
    part.catalogStatus = TakeoutCatalogStatus.Complete;
    ctx.stats.finish(ps, 'read');
  } catch (error) {
    await batch.settle();
    ctx.stats.endPass(ps);
    if (ctx.readAbort.signal.aborted || error instanceof RunFailure) {
      // the part stays 'reading' and becomes 'partial' when the run stops
      throw error;
    }
    if (error instanceof ArchiveChangedError) {
      await repo.deleteEntriesOfPart(part.id);
      throw error;
    }
    if (error instanceof GzipIntegrityError) {
      // trailer CRC or length mismatch: no entry of this part can be trusted
      await repo.failPart(part.id, {
        deleteEntries: true,
        catalogError: `gzip CRC mismatch: ${messageOf(error)}`,
        offset: error.byteOffset,
        bytesRead: ps.bytesRead,
      });
      part.catalogStatus = TakeoutCatalogStatus.Error;
      ctx.stats.finish(ps, 'error', error);
      return;
    }
    if (isArchiveDataError(error)) {
      const current = inFlight as ArchiveEntryInfo | null;
      await repo.failPart(part.id, {
        errorRow: current ? toInsertable(errorRow(part, current, `truncated or corrupt: ${messageOf(error)}`)) : null,
        catalogError: messageOf(error),
        offset: error.byteOffset,
        bytesRead: ps.bytesRead,
      });
      part.catalogStatus = TakeoutCatalogStatus.Error;
      ctx.stats.finish(ps, 'error', error);
      return;
    }
    // I/O after the transport budget, a vanished file: readPartWithRetry decides
    throw error;
  }
}

/** Stat fresh at every attempt; transport errors outlived the in-place budget: a few whole-part attempts */
export async function readPartWithRetry(ctx: ReadContext, part: ReadPartRow, token: ReaderToken): Promise<void> {
  let changedOnce = false;
  for (let attempt = 0; ; attempt++) {
    const path = ctx.partPath(part.fileName);
    const st = await statFingerprint(path, ctx.limits);
    if (!st) {
      throw new RunFailure(`${part.fileName} disappeared while it was read`);
    }
    if (!isStableNow(st, ctx.limits)) {
      throw new RunFailure(`${part.fileName} is still being copied`);
    }
    try {
      await readPart(ctx, part, st, token);
      return;
    } catch (error) {
      if (ctx.readAbort.signal.aborted || error instanceof RunFailure) {
        throw error;
      }
      if (error instanceof ArchiveChangedError) {
        // one immediate fresh read, no retry slot used
        if (changedOnce) {
          throw new RunFailure(`${part.fileName} changed while it was read`);
        }
        changedOnce = true;
        attempt--;
        part.catalogStatus = TakeoutCatalogStatus.None;
        part.catalogVersion = null;
        continue;
      }
      if (error instanceof PartMissingError && attempt === 0) {
        // the next stat tells whether it is really gone
        continue;
      }
      if (attempt >= ctx.limits.ioRetries.length || !(isTransportError(error) || (error as { code?: string }).code)) {
        throw new RunFailure(`Could not read ${part.fileName}: ${messageOf(error)}`);
      }
      ctx.deps.logger.warn(`Takeout: reading ${part.fileName} failed (${messageOf(error)}), trying again`);
      await sleepAbortable(ctx.limits.ioRetries[attempt], ctx.readAbort.signal);
    }
  }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------- the reader pool ----------

/**
 * Runs `fn` over the items with `n` workers, each holding a process reader slot per item. The first rejection
 * aborts the run's read signal with that reason; after an abort the workers get `capMs` to settle, and a worker still
 * inside a read is detached: it writes nothing more and its file handle closes when the read returns. Then the run's
 * writes are drained (queued ones dropped after an abort) and the first failure is rethrown.
 */
export async function readerPool<T>(
  ctx: ReadContext,
  items: T[],
  n: number,
  fn: (item: T, token: ReaderToken) => Promise<void>,
): Promise<void> {
  let next = 0;
  let firstError: unknown = null;
  const tokens: ReaderToken[] = [];
  const worker = async (token: ReaderToken) => {
    while (!ctx.readAbort.signal.aborted && next < items.length) {
      const item = items[next++];
      let slot: ByteLease | null = null;
      try {
        slot = await ctx.resources.readers.acquire(1, ctx.readAbort.signal);
        await fn(item, token);
      } catch (error) {
        if (!ctx.readAbort.signal.aborted) {
          firstError ??= error;
          ctx.readAbort.abort(asRunReason(error));
        }
        return;
      } finally {
        slot?.release();
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, n) }, () => {
    const token: ReaderToken = { detached: false };
    tokens.push(token);
    return { token, done: false, promise: null as Promise<void> | null };
  });
  for (const w of workers) {
    w.promise = worker(w.token).finally(() => {
      w.done = true;
    });
  }
  const all = Promise.allSettled(workers.map((w) => w.promise!));
  const aborted = new Promise<void>((resolve) => {
    if (ctx.readAbort.signal.aborted) {
      resolve();
    } else {
      ctx.readAbort.signal.addEventListener('abort', () => resolve(), { once: true });
    }
  });
  await Promise.race([
    all,
    aborted.then(() => new Promise<void>((resolve) => setTimeout(resolve, ctx.limits.cancelReaderCapMs))),
  ]);
  for (const w of workers) {
    if (w.done) {
      continue;
    }

    w.token.detached = true;
    ctx.deps.logger.warn(`Takeout run ${ctx.run.id}: a reader did not stop in time and was detached`);
  }
  const wasAborted = ctx.readAbort.signal.aborted;
  await ctx.resources.writes.drain(
    ctx.run.id,
    wasAborted ? { dropQueued: true, capMs: ctx.limits.cancelWriteCapMs } : { dropQueued: false, capMs: Infinity },
  );
  if (!wasAborted && ctx.staging.pendingReservations() > 0) {
    // a leak would drop a file: never continue with one
    throw new RunFailure('internal error: staged writes were lost');
  }
  if (wasAborted) {
    throw ctx.readAbort.signal.reason ?? firstError;
  }
  if (firstError) {
    throw asRunReason(firstError);
  }
  if (ctx.staging.fatal) {
    // a write-behind failed after its reader moved on (ENOSPC, a share that stopped answering)
    throw asRunReason(ctx.staging.fatal);
  }
}

// ---------- fetching (single-pass design 8) ----------

export interface FetchOccurrence {
  partName: string;
  kind: string;
  seq: number | null;
  path: string;
  size: number;
  endOffset: number | null;
}

export interface FetchRequest {
  kind: 'blob' | 'sample';
  checksum: Buffer;
  size: number;
  occurrences: FetchOccurrence[];
  /** index of the occurrence tried next */
  cursor: number;
  satisfied: boolean;
  failure: string | null;
  /** sample requests: the entry that gets the sample */
  entryId?: number | string;
}

/** zip entries first (smallest span), then tgz entries by smallest end offset */
export function rankOccurrences(occurrences: FetchOccurrence[]): FetchOccurrence[] {
  const rank = (o: FetchOccurrence) => (o.kind === 'zip' ? 0 : 1);
  return [...occurrences].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.kind === 'zip'
        ? a.size - b.size
        : (a.endOffset ?? Number.MAX_SAFE_INTEGER) - (b.endOffset ?? Number.MAX_SAFE_INTEGER)),
  );
}

async function stageVerified(ctx: ReadContext, request: FetchRequest, open: EntryOpener): Promise<void> {
  if (request.kind === 'sample') {
    if (request.size > ctx.limits.sampleBufferLimit) {
      await ctx.deps.repo.updateEntry(request.entryId!, { sampleSkipped: TakeoutSampleSkipped.TooLarge });
      request.satisfied = true;
      return;
    }
    const lease = await ctx.resources.memory.acquire(request.size, ctx.readAbort.signal);
    try {
      const { buf, checksum } = await readFully(await open(), request.size);
      if (!checksum.equals(request.checksum)) {
        request.failure = 'the archive changed since it was read';
        return;
      }
      await applySample(ctx, request, await ctx.resources.sampler.sample(buf, lease.share(), ctx.readAbort.signal));
    } finally {
      lease.release();
    }
    return;
  }

  const h = hex(request.checksum);
  if (ctx.staging.hasBlob(h)) {
    request.satisfied = true;
    return;
  }
  const reservation = ctx.staging.reserve(h);
  if (!reservation) {
    request.satisfied = true;
    return;
  }
  let slot: ByteLease | null = null;
  try {
    slot = await ctx.resources.writes.acquireSlot(ctx.readAbort.signal);
    const written = await ctx.staging.streamToTemp(await open());
    if (written.checksum.equals(request.checksum)) {
      await ctx.staging.commitTemp(written.tmp, reservation, written.size);
      request.satisfied = true;
      ctx.stats.stats.fetchFiles++;
    } else {
      await ctx.staging.discardTemp(written.tmp);
      request.failure = 'the archive changed since it was read';
    }
  } finally {
    slot?.release();
    reservation.releaseIfPending();
  }
}

/** A null result (the read was stopped before the sample was computed) leaves the entry as it is */
export async function applySample(
  ctx: ReadContext,
  request: FetchRequest,
  result: ImageSampleResult | null,
): Promise<void> {
  if (!result) {
    return;
  }
  if ('skipped' in result) {
    await ctx.deps.repo.updateEntry(request.entryId!, { sampleSkipped: result.skipped as TakeoutSampleSkipped });
  } else {
    await ctx.deps.repo.updateEntry(request.entryId!, {
      sample: result.sample,
      width: result.width,
      height: result.height,
    });
    ctx.stats.stats.sampleBackfillFiles++;
  }
  request.satisfied = true;
}

async function fetchPart(
  ctx: ReadContext,
  part: ReadPartRow,
  requests: FetchRequest[],
  planned: number,
  token: ReaderToken,
): Promise<void> {
  const ps = ctx.stats.part(part);
  const meter = newReadMeter();
  // live fetch progress (the tick reads it) and the stall watchdog; ended on every path, so the total takes what
  // was really read
  const pass = ctx.stats.beginFetch(ps, meter, planned);
  const unwatch = ctx.watch(part.fileName, meter);
  try {
    await fetchPartWalk(ctx, part, requests, meter, token);
  } finally {
    unwatch();
    ctx.stats.endFetch(pass);
  }
}

async function fetchPartWalk(
  ctx: ReadContext,
  part: ReadPartRow,
  requests: FetchRequest[],
  meter: ReadMeter,
  token: ReaderToken,
): Promise<void> {
  const path = ctx.partPath(part.fileName);
  const st = await statFingerprint(path, ctx.limits);
  if (!st) {
    throw new RunFailure(`${part.fileName} is missing: put it back and Resume, or cancel the run`);
  }
  const useSeq = keyEqual(part, st);
  const bySeq = new Map<number, FetchRequest[]>();
  const byPathSize = new Map<string, FetchRequest[]>();
  const add = <K>(map: Map<K, FetchRequest[]>, key: K, request: FetchRequest) => {
    const list = map.get(key) ?? [];
    list.push(request);
    map.set(key, list);
  };
  let allSeqs = true;
  for (const request of requests) {
    const occurrence = request.occurrences[request.cursor];
    if (useSeq && occurrence.seq !== null) {
      add(bySeq, occurrence.seq, request);
    } else {
      allSeqs = false;
      add(byPathSize, `${occurrence.path}\0${occurrence.size}`, request);
    }
  }
  let remaining = requests.length;
  const kind = part.kind === 'zip' ? 'zip' : 'tgz';
  const seqs = allSeqs ? bySeq.keys().toArray() : [];
  try {
    await walkArchive(
      path,
      kind,
      async (info, open) => {
        if (token.detached) {
          throw new RunFailure('reader detached');
        }
        const matched = [
          ...(bySeq.get(info.seq) ?? []),
          ...(byPathSize.get(`${info.path}\0${info.size}`) ?? []),
        ].filter((request) => !request.satisfied && request.failure === null);
        if (matched.length === 0) {
          return;
        }
        if (info.error) {
          for (const request of matched) {
            request.failure = info.error;
            remaining--;
          }
          return;
        }
        // one open per entry: a blob request and a sample request of the same entry are served in turn by re-reading
        // only when both exist (rare); the blob comes first
        const [first, ...others] = matched.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'blob' ? -1 : 1));
        try {
          await stageVerified(ctx, first, open);
        } catch (error) {
          if (!(error instanceof EntryDataError)) {
            throw error;
          }
          first.failure = messageOf(error);
        }
        remaining--;
        for (const other of others) {
          if (other.kind === 'sample' && first.kind === 'blob' && first.satisfied) {
            // the content is staged now: sample it from the blob instead of the archive
            await sampleFromFile(ctx, other, ctx.staging.blobPath(hex(other.checksum)));
          }
          remaining--;
        }
      },
      {
        signal: ctx.readAbort.signal,
        fingerprint: st,
        source: ctx.sourceOptions(),
        meter,
        seqs: kind === 'zip' && allSeqs ? new Set(seqs) : undefined,
        untilSeq: kind === 'tgz' && allSeqs && seqs.length > 0 ? Math.max(...seqs) : undefined,
        shouldStop: () => remaining <= 0,
        zipSeekGap: ctx.limits.zipSeekGap,
        throttleMBps: ctx.limits.throttleMBps,
      },
    );
  } catch (error) {
    if (ctx.readAbort.signal.aborted || error instanceof RunFailure) {
      throw error;
    }
    if (isArchiveDataError(error) || error instanceof ArchiveChangedError) {
      // the requests that were not served try their next occurrence
      return;
    }
    // I/O after the transport budget: resumable, never a row error
    throw new RunFailure(`Could not read ${part.fileName}: ${messageOf(error)}`);
  }
}

async function sampleFromFile(ctx: ReadContext, request: FetchRequest, path: string): Promise<boolean> {
  if (request.size > ctx.limits.sampleBufferLimit) {
    await ctx.deps.repo.updateEntry(request.entryId!, { sampleSkipped: TakeoutSampleSkipped.TooLarge });
    request.satisfied = true;
    return true;
  }
  const handle = await fsOpen(path, 'r').catch(() => null);
  if (!handle) {
    return false;
  }
  const lease = await ctx.resources.memory.acquire(request.size, ctx.readAbort.signal);
  try {
    const { buf, checksum } = await readFully(handle.createReadStream({ autoClose: false }), request.size).catch(
      () => ({ buf: null, checksum: null }),
    );
    if (!buf || !checksum?.equals(request.checksum)) {
      return false;
    }
    await applySample(ctx, request, await ctx.resources.sampler.sample(buf, lease.share(), ctx.readAbort.signal));
    return true;
  } finally {
    lease.release();
    await handle.close().catch(noop);
  }
}

/** The bytes a fetch of `part` for these requests (at their current occurrence) is expected to read */
function plannedFetchBytes(part: ReadPartRow, requests: FetchRequest[]): number {
  let planned = 0;
  for (const request of requests) {
    const occurrence = request.occurrences[request.cursor];
    planned =
      occurrence.kind === 'zip'
        ? planned + occurrence.size
        : Math.max(planned, occurrence.endOffset ?? Number(part.size ?? occurrence.size));
  }
  return planned;
}

/**
 * Serve every request from the cheapest occurrence that works (single-pass design 8.2, 8.3). Returns the requests
 * that could not be served, with their failure ('file not found in the archive' when no occurrence had it).
 */
export async function fetchEntries(
  ctx: ReadContext,
  parts: Map<string, ReadPartRow>,
  requests: FetchRequest[],
): Promise<FetchRequest[]> {
  // samples first from content that is already here: a staged blob or a server original (same bytes)
  for (const request of requests) {
    if (request.kind !== 'sample' || request.satisfied) {
      continue;
    }
    const blob = ctx.staging.hasBlob(hex(request.checksum)) ? ctx.staging.blobPath(hex(request.checksum)) : null;
    if (blob && (await sampleFromFile(ctx, request, blob))) {
      continue;
    }
    const [asset] = await ctx.deps.repo.getUploadAssetsByChecksums(ctx.run.userId, [request.checksum]);
    if (asset?.originalPath) {
      await sampleFromFile(ctx, request, asset.originalPath);
    }
  }

  let pending = requests.filter((request) => !request.satisfied);
  for (const request of pending) {
    request.occurrences = rankOccurrences(request.occurrences);
  }

  while (pending.length > 0) {
    const byPart = new Map<string, FetchRequest[]>();
    const attempted: FetchRequest[] = [];
    for (const request of pending) {
      // occurrences in parts that are not usable any more are skipped
      while (request.cursor < request.occurrences.length && !parts.has(request.occurrences[request.cursor].partName)) {
        request.cursor++;
      }
      const occurrence = request.occurrences[request.cursor];
      if (!occurrence) {
        request.failure ??= 'file not found in the archive';
        continue;
      }
      request.failure = null;
      attempted.push(request);
      const list = byPart.get(occurrence.partName) ?? [];
      list.push(request);
      byPart.set(occurrence.partName, list);
    }
    // fetch progress: each part of this round adds what it is expected to read to the total up front (tgz up to its
    // last needed entry, the part size without offsets; zip the requested entries); a fallback round adds its own
    // parts when they are tried. A part that ends takes its real bytes in place of the plan (endFetch).
    const work = byPart
      .entries()
      .map(([partName, list]) => ({
        part: parts.get(partName)!,
        requests: list,
        planned: plannedFetchBytes(parts.get(partName)!, list),
        started: false,
      }))
      .toArray();
    ctx.stats.stats.fetchBytesTotal += work.reduce((sum, item) => sum + item.planned, 0);
    try {
      if (work.length > 0) {
        await readerPool(ctx, work, Math.min(ctx.limits.readers, work.length), (item, token) => {
          item.started = true;
          return fetchPart(ctx, item.part, item.requests, item.planned, token);
        });
      }
    } finally {
      // parts an abort kept from starting leave the total
      for (const item of work) {
        if (!item.started) {
          ctx.stats.stats.fetchBytesTotal = Math.max(0, ctx.stats.stats.fetchBytesTotal - item.planned);
        }
      }
    }
    const next: FetchRequest[] = [];
    for (const request of attempted) {
      if (request.satisfied) {
        continue;
      }
      const lastFailure = request.failure;
      request.cursor++;
      if (request.cursor < request.occurrences.length) {
        next.push(request);
      } else {
        request.failure = lastFailure ?? 'file not found in the archive';
      }
    }
    pending = next;
  }
  return requests.filter((request) => !request.satisfied);
}
