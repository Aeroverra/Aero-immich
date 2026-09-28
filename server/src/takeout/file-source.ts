import { open as fsOpen } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { ByteLease, ByteSemaphore } from 'src/takeout/byte-semaphore';
import { ArchiveChangedError, PartMissingError } from 'src/takeout/errors';
import { FileFingerprint, ReadMeter } from 'src/takeout/types';

// Positional reads with application readahead over one file (single-pass design 6.7). Transport errors (EIO,
// ETIMEDOUT, EAGAIN, EINTR) retry the same (position, length) in place, so an NFS hiccup never restarts a part.
// ESTALE and EBADF reopen the path and compare the fingerprint. A read that never returns keeps its handle open (the
// thread is stuck in the kernel) and never blocks a destroy; the handle is closed when the read finally returns.

const MiB = 1024 * 1024;
const TRANSPORT_CODES = new Set(['EIO', 'ETIMEDOUT', 'EAGAIN', 'EINTR']);
const REOPEN_CODES = new Set(['ESTALE', 'EBADF']);
export const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000];

export interface FileHandleLike {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  stat(): Promise<{ size: number | bigint; mtimeMs: number | bigint; ctimeMs: number | bigint; ino: number | bigint }>;
  close(): Promise<void>;
}

export interface FileSourceFs {
  open(path: string): Promise<FileHandleLike>;
}

export interface FileSourceClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface FileSourceOptions {
  /** bytes per positional read */
  chunk?: number;
  /** positional reads in flight (application readahead) */
  depth?: number;
  /** how long a streak of transport errors is retried in place */
  retryBudgetMs?: number;
  backoffMs?: number[];
  /** expected in-run fingerprint; a mismatch at open or after a reopen is ArchiveChangedError */
  fingerprint?: FileFingerprint | null;
  /** readahead memory (depth x chunk) is taken from this budget for the life of the source */
  memory?: ByteSemaphore | null;
  signal?: AbortSignal;
  fs?: FileSourceFs;
  clock?: FileSourceClock;
  /** test only: limit the read rate */
  throttleMBps?: number | null;
  /** counters shared with the caller (bytesRead, bytesSkipped, transportRetries, pendingSince, position) */
  meter?: ReadMeter;
}

export const nodeFileSourceFs: FileSourceFs = {
  open: (path: string) => fsOpen(path, 'r') as unknown as Promise<FileHandleLike>,
};

export const realClock: FileSourceClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

export function newReadMeter(): ReadMeter {
  return { position: 0, bytesRead: 0, bytesSkipped: 0, transportRetries: 0, pendingSince: null };
}

export function fingerprintOf(st: {
  size: number | bigint;
  mtimeMs: number | bigint;
  ctimeMs: number | bigint;
  ino: number | bigint;
}): FileFingerprint {
  return { size: Number(st.size), mtimeMs: Number(st.mtimeMs), ctimeMs: Number(st.ctimeMs), ino: Number(st.ino) };
}

export function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

export function isTransportError(error: unknown): boolean {
  const code = codeOf(error);
  return code !== undefined && TRANSPORT_CODES.has(code);
}

interface HandleRef {
  fh: FileHandleLike;
  gen: number;
  inflight: number;
  retired: boolean;
  closed: boolean;
}

interface Slot {
  pos: number;
  len: number;
  /** bytes of the slot before this offset were skipped by a seek */
  trim: number;
  buf: Buffer | null;
  error: unknown;
  done: boolean;
  cancelled: boolean;
  /** cancelled while its read(2) was in flight: still occupies a readahead place until it returns */
  counted: boolean;
  /** part of the sequential readahead (not a readAt) */
  sequential: boolean;
  startedAt: number | null;
  settle: () => void;
  promise: Promise<void>;
}

export class FileSource {
  readonly size: number;
  /** next byte next() returns */
  position = 0;
  private end = 0;
  /** next position a readahead read is issued for */
  private nextPos = 0;
  private slots: Slot[] = [];
  private cancelledInflight = 0;
  private inflight = new Set<Slot>();
  private handle: HandleRef;
  private reopening: Promise<HandleRef> | null = null;
  private retiredHandles = new Set<HandleRef>();
  private destroyedError: unknown = null;
  private destroyWaiters = new Set<(error: unknown) => void>();
  private memoryLease: ByteLease | null;
  private throttleAt = 0;
  private readonly chunk: number;
  private readonly depth: number;
  private readonly budgetMs: number;
  private readonly backoff: number[];
  private readonly fs: FileSourceFs;
  private readonly clock: FileSourceClock;
  private readonly fingerprint: FileFingerprint;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly onAbort: () => void;
  private closedResolve!: () => void;
  /** resolves when every handle of the source is closed */
  readonly closed: Promise<void>;
  readonly meter: ReadMeter;

  private constructor(
    readonly path: string,
    fh: FileHandleLike,
    fingerprint: FileFingerprint,
    private readonly options: FileSourceOptions,
    memoryLease: ByteLease | null,
  ) {
    this.size = fingerprint.size;
    this.fingerprint = fingerprint;
    this.handle = { fh, gen: 0, inflight: 0, retired: false, closed: false };
    this.chunk = options.chunk ?? 4 * MiB;
    this.depth = Math.max(1, options.depth ?? 4);
    this.budgetMs = options.retryBudgetMs ?? 10 * 60_000;
    this.backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.fs = options.fs ?? nodeFileSourceFs;
    this.clock = options.clock ?? realClock;
    this.meter = options.meter ?? newReadMeter();
    this.memoryLease = memoryLease;
    this.end = this.size;
    this.closed = new Promise<void>((resolve) => (this.closedResolve = resolve));
    this.abortSignal = options.signal;
    this.onAbort = () => this.destroy(options.signal?.reason);
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  static async open(path: string, options: FileSourceOptions = {}): Promise<FileSource> {
    const fs = options.fs ?? nodeFileSourceFs;
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    let fh: FileHandleLike;
    try {
      fh = await fs.open(path);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') {
        throw new PartMissingError(`${path} is missing`);
      }
      throw error;
    }
    let fingerprint: FileFingerprint;
    try {
      fingerprint = fingerprintOf(await fh.stat());
      if (options.fingerprint && !sameFingerprint(fingerprint, options.fingerprint)) {
        throw new ArchiveChangedError();
      }
    } catch (error) {
      await fh.close().catch(() => {});
      throw error;
    }
    let lease: ByteLease | null = null;
    if (options.memory) {
      const depth = Math.max(1, options.depth ?? 4);
      try {
        lease = await options.memory.acquire(depth * (options.chunk ?? 4 * MiB), options.signal);
      } catch (error) {
        await fh.close().catch(() => {});
        throw error;
      }
    }
    return new FileSource(path, fh, fingerprint, options, lease);
  }

  get destroyed(): boolean {
    return this.destroyedError !== null;
  }

  /** Sequential range read by next(); the readahead starts with the first next() */
  setRange(start: number, end: number): void {
    this.dropSlots();
    this.position = start;
    this.nextPos = start;
    this.end = Math.min(end, this.size);
    this.meter.position = start;
  }

  /** Continue sequential reading at `pos`; readahead that covers `pos` is kept, the rest is dropped */
  seek(pos: number): void {
    if (pos === this.position) {
      return;
    }
    if (pos < this.position || pos >= this.nextPos) {
      if (pos > this.nextPos) {
        this.meter.bytesSkipped += pos - this.nextPos;
      }
      this.dropSlots();
      this.nextPos = Math.min(pos, this.end);
    } else {
      while (this.slots.length > 0 && this.slots[0].pos + this.slots[0].len <= pos) {
        this.cancelSlot(this.slots.shift()!);
      }
      const head = this.slots[0];
      if (head && head.pos < pos) {
        head.trim = pos - head.pos;
      }
    }
    this.position = pos;
    this.meter.position = pos;
  }

  /** The next chunk of the sequential range, null at its end */
  async next(): Promise<Buffer | null> {
    this.throwIfDestroyed();
    if (this.position >= this.end) {
      return null;
    }
    this.fill();
    const head = this.slots[0];
    await this.raceDestroy(head.promise);
    this.throwIfDestroyed();
    if (this.slots[0] !== head) {
      // a seek replaced the readahead while we waited: read again from the new position
      return this.next();
    }
    if (head.error) {
      this.destroy(head.error);
      throw head.error;
    }
    this.slots.shift();
    const buf = head.trim > 0 ? head.buf!.subarray(head.trim) : head.buf!;
    this.position = head.pos + head.len;
    this.meter.position = this.position;
    this.fill();
    return buf;
  }

  /** One positional read outside the sequential range (zip directory), with the same retries */
  async readAt(pos: number, len: number): Promise<Buffer> {
    this.throwIfDestroyed();
    const slot = this.newSlot(pos, len, false);
    void this.runSlot(slot);
    await this.raceDestroy(slot.promise);
    this.throwIfDestroyed();
    if (slot.error) {
      throw slot.error;
    }
    return slot.buf!;
  }

  /** Start time of the oldest read in flight (stall watchdog), null when none */
  pendingSince(): number | null {
    let oldest: number | null = null;
    for (const slot of this.inflight) {
      if (slot.startedAt !== null && (oldest === null || slot.startedAt < oldest)) {
        oldest = slot.startedAt;
      }
    }
    return oldest;
  }

  /** Stop reading; handles close as soon as no read is in flight on them. Never throws. */
  destroy(error?: unknown): void {
    if (this.destroyedError !== null) {
      return;
    }
    this.destroyedError = error ?? new Error('file source destroyed');
    this.abortSignal?.removeEventListener('abort', this.onAbort);
    this.dropSlots();
    for (const waiter of this.destroyWaiters) {
      waiter(this.destroyedError);
    }
    this.destroyWaiters.clear();
    this.handle.retired = true;
    this.retiredHandles.add(this.handle);
    this.closeIdleHandles();
  }

  /** A Readable over the sequential range (tgz: piped into gunzip) */
  toReadable(): Readable {
    const readable: Readable = new Readable({
      highWaterMark: 0,
      read: () => {
        this.next()
          .then((buf) => readable.push(buf))
          .catch((error: unknown) => readable.destroy(error as Error));
      },
      destroy: (error, callback) => {
        this.destroy(error ?? undefined);
        callback(error);
      },
    });
    return readable;
  }

  // ---------- internals ----------

  private throwIfDestroyed() {
    if (this.destroyedError !== null) {
      throw this.destroyedError;
    }
  }

  private raceDestroy(promise: Promise<void>): Promise<void> {
    if (this.destroyedError !== null) {
      return Promise.reject(this.destroyedError);
    }
    return new Promise<void>((resolve, reject) => {
      const onDestroy = (error: unknown) => reject(error);
      this.destroyWaiters.add(onDestroy);
      void promise.then(() => {
        this.destroyWaiters.delete(onDestroy);
        resolve();
      });
    });
  }

  private newSlot(pos: number, len: number, sequential: boolean): Slot {
    let settle!: () => void;
    const promise = new Promise<void>((resolve) => (settle = resolve));
    return {
      pos,
      len,
      trim: 0,
      buf: null,
      error: null,
      done: false,
      cancelled: false,
      counted: false,
      sequential,
      startedAt: null,
      settle,
      promise,
    };
  }

  private fill() {
    while (
      this.destroyedError === null &&
      this.slots.length + this.cancelledInflight < this.depth &&
      this.nextPos < this.end
    ) {
      this.issue();
    }
    // the head is always issued, even when cancelled reads still occupy the depth
    if (this.slots.length === 0 && this.destroyedError === null && this.nextPos < this.end) {
      this.issue();
    }
  }

  private issue() {
    const len = Math.min(this.chunk, this.end - this.nextPos);
    const slot = this.newSlot(this.nextPos, len, true);
    this.nextPos += len;
    this.slots.push(slot);
    void this.runSlot(slot);
  }

  private cancelSlot(slot: Slot) {
    slot.cancelled = true;
    if (!slot.done && slot.startedAt !== null && !slot.counted) {
      slot.counted = true;
      this.cancelledInflight++;
    }
  }

  private dropSlots() {
    for (const slot of this.slots) {
      this.cancelSlot(slot);
    }
    this.slots = [];
  }

  private async currentHandle(): Promise<HandleRef> {
    if (this.reopening) {
      return this.reopening;
    }
    return this.handle;
  }

  private reopen(stale: HandleRef): Promise<HandleRef> {
    if (this.handle !== stale) {
      return this.currentHandle();
    }
    if (this.reopening) {
      return this.reopening;
    }
    this.reopening = (async () => {
      stale.retired = true;
      this.retiredHandles.add(stale);
      this.closeIdleHandles();
      let fh: FileHandleLike;
      try {
        fh = await this.fs.open(this.path);
      } catch (error) {
        if (codeOf(error) === 'ENOENT') {
          throw new PartMissingError(`${this.path} disappeared while it was read`);
        }
        throw error;
      }
      let fingerprint: FileFingerprint;
      try {
        fingerprint = fingerprintOf(await fh.stat());
      } catch (error) {
        await fh.close().catch(() => {});
        throw error;
      }
      const expected = this.options.fingerprint ?? this.fingerprint;
      if (!sameFingerprint(fingerprint, expected)) {
        await fh.close().catch(() => {});
        throw new ArchiveChangedError();
      }
      const ref: HandleRef = { fh, gen: stale.gen + 1, inflight: 0, retired: false, closed: false };
      if (this.destroyedError === null) {
        this.handle = ref;
      } else {
        ref.retired = true;
        this.retiredHandles.add(ref);
      }
      this.closeIdleHandles();
      return ref;
    })();
    const done = this.reopening;
    const clear = () => {
      if (this.reopening === done) {
        this.reopening = null;
      }
      this.closeIdleHandles();
    };
    void done.catch(() => {}).finally(clear);
    return done;
  }

  private async throttle(len: number) {
    const rate = this.options.throttleMBps;
    if (!rate || rate <= 0) {
      return;
    }
    const now = this.clock.now();
    const start = Math.max(now, this.throttleAt);
    this.throttleAt = start + (len * 1000) / (rate * 1_000_000);
    if (start > now) {
      await this.clock.sleep(start - now, this.abortSignal);
    }
  }

  private async runSlot(slot: Slot): Promise<void> {
    try {
      await this.readSlot(slot);
    } catch (error) {
      // never let a read promise reject unhandled: the error is delivered through the slot
      slot.error ??= error;
    } finally {
      slot.done = true;
      if (slot.cancelled) {
        slot.buf = null;
      }
      slot.settle();
      if (slot.sequential && !slot.cancelled && this.destroyedError === null) {
        this.fill();
      }
    }
  }

  private async readSlot(slot: Slot): Promise<void> {
    let streakStart: number | null = null;
    let attempt = 0;
    for (;;) {
      if (this.destroyedError !== null || slot.cancelled) {
        return;
      }
      await this.throttle(slot.len);
      const ref = await this.currentHandle();
      if (this.destroyedError !== null || slot.cancelled) {
        return;
      }
      ref.inflight++;
      slot.startedAt = this.clock.now();
      this.inflight.add(slot);
      this.updatePending();
      let failure: unknown = null;
      try {
        slot.buf = await readFullyAt(ref.fh, slot.pos, slot.len, this.meter);
      } catch (error) {
        failure = error;
      } finally {
        ref.inflight--;
        this.inflight.delete(slot);
        slot.startedAt = null;
        if (slot.counted) {
          slot.counted = false;
          this.cancelledInflight--;
        }
        this.updatePending();
        this.closeIdleHandles();
      }
      if (failure === null) {
        return;
      }
      if (isTransportError(failure)) {
        const now = this.clock.now();
        streakStart ??= now;
        if (now - streakStart >= this.budgetMs) {
          slot.error = failure;
          return;
        }
        this.meter.transportRetries++;
        const wait = this.backoff[Math.min(attempt, this.backoff.length - 1)];
        attempt++;
        await this.clock.sleep(wait, this.abortSignal);
        continue;
      }
      if (REOPEN_CODES.has(codeOf(failure) ?? '')) {
        await this.reopen(ref);
        continue;
      }
      slot.error = failure;
      return;
    }
  }

  private updatePending() {
    this.meter.pendingSince = this.pendingSince();
  }

  private closeIdleHandles() {
    const all = new Set(this.retiredHandles);
    for (const ref of all) {
      if (!(ref.retired && !ref.closed && ref.inflight === 0)) {
        continue;
      }

      ref.closed = true;
      this.retiredHandles.delete(ref);
      void ref.fh.close().catch(() => {});
    }
    if (this.destroyedError !== null && this.inflight.size === 0 && this.retiredHandles.size === 0 && !this.reopening) {
      if (this.memoryLease) {
        this.memoryLease.release();
        this.memoryLease = null;
      }
      this.closedResolve();
    }
  }
}

/** read(2) until `len` bytes arrived; 0 bytes before that means the file is shorter than it was */
async function readFullyAt(fh: FileHandleLike, pos: number, len: number, meter: ReadMeter): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(len);
  let filled = 0;
  while (filled < len) {
    const { bytesRead } = await fh.read(buf, filled, len - filled, pos + filled);
    if (bytesRead === 0) {
      throw new ArchiveChangedError('the archive ended early (it changed while it was read)');
    }
    filled += bytesRead;
    meter.bytesRead += bytesRead;
  }
  return buf;
}
