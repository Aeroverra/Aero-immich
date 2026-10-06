// Flow control of the archive reads: a gate that holds reads while a run is paused (or a reader is held back by a
// lowered reader count), and a token bucket that limits the read rate of the whole process. Both change while reads
// wait on them: opening a gate lets its waiters through at once, and a new rate applies to the reads already waiting.

/** Something a reader passes before every positional read */
export interface ReadGate {
  readonly isOpen: boolean;
  /** Resolves once the gate is open (at once when it is); rejects with the signal's reason on abort */
  wait(signal?: AbortSignal): Promise<void>;
}

export interface GateChange {
  open: boolean;
  /** how long the gate was closed, when it opens (0 when it closes) */
  closedMs: number;
}

export class Gate implements ReadGate {
  private closedSince: number | null = null;
  private waiters = new Set<() => void>();
  private listeners = new Set<(change: GateChange) => void>();
  /** when the gate opened last (null: it never closed) */
  openedAt: number | null = null;

  get isOpen(): boolean {
    return this.closedSince === null;
  }

  /** since when the gate is closed, null while open */
  get closedAt(): number | null {
    return this.closedSince;
  }

  /** Close the gate; false when it was closed already */
  close(now = Date.now()): boolean {
    if (this.closedSince !== null) {
      return false;
    }
    this.closedSince = now;
    this.notify({ open: false, closedMs: 0 });
    return true;
  }

  /** Open the gate and let every waiter through; returns how long it was closed (0 when it was open) */
  open(now = Date.now()): number {
    if (this.closedSince === null) {
      return 0;
    }
    const closedMs = Math.max(0, now - this.closedSince);
    this.closedSince = null;
    this.openedAt = now;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
    this.notify({ open: true, closedMs });
    return closedMs;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.closedSince === null) {
      return Promise.resolve();
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters.delete(done);
        reject(signal!.reason);
      };
      const done = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.add(done);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Called on every change; returns the unsubscribe function */
  onChange(listener: (change: GateChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(change: GateChange) {
    for (const listener of this.listeners) {
      listener(change);
    }
  }
}

/** Several gates in a row: open when every one is open */
export function allGates(...gates: Array<ReadGate | null | undefined>): ReadGate {
  const list = gates.filter((gate): gate is ReadGate => !!gate);
  return {
    get isOpen() {
      return list.every((gate) => gate.isOpen);
    },
    async wait(signal?: AbortSignal) {
      // a gate can close again while another one is waited for: loop until all are open at the same time
      while (list.some((gate) => !gate.isOpen)) {
        for (const gate of list) {
          await gate.wait(signal);
        }
      }
    },
  };
}

export interface ThrottleClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

export const realThrottleClock: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

interface ThrottleWaiter {
  bytes: number;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * A token bucket shared by every archive read of the process. A read is let through while the bucket is not in debt
 * and takes its bytes from it (the bucket may go into debt by one read); the debt is paid back at the rate. At most
 * 250 ms of the rate is saved up while nothing reads. Waiting reads are served in order, and a rate change applies to
 * them at once: raising the rate shortens the wait, lowering it lengthens it, null (or 0) lets everything through.
 */
export class ReadThrottle {
  private bytesPerSecond: number | null = null;
  private tokens = 0;
  private last: number;
  private queue: ThrottleWaiter[] = [];
  private timer: unknown = null;
  /** bytes let through, for tests and statistics */
  passed = 0;

  constructor(
    mbps: number | null = null,
    private readonly clock: ThrottleClock = realThrottleClock,
  ) {
    this.last = clock.now();
    this.setRate(mbps);
  }

  /** the limit in MB/s (1 MB = 1,000,000 bytes), null when unlimited */
  get rateMBps(): number | null {
    return this.bytesPerSecond === null ? null : this.bytesPerSecond / 1_000_000;
  }

  get waiting(): number {
    return this.queue.length;
  }

  setRate(mbps: number | null | undefined): void {
    this.refill();
    const rate = mbps && mbps > 0 ? mbps * 1_000_000 : null;
    if (rate === this.bytesPerSecond) {
      return;
    }
    this.bytesPerSecond = rate;
    this.clearTimer();
    if (rate === null) {
      this.tokens = 0;
      const waiters = this.queue;
      this.queue = [];
      for (const waiter of waiters) {
        this.grant(waiter);
      }
      return;
    }
    this.tokens = Math.min(this.tokens, this.burst());
    this.schedule();
  }

  /** Wait until `bytes` may be read */
  take(bytes: number, signal?: AbortSignal): Promise<void> {
    if (this.bytesPerSecond === null) {
      this.passed += bytes;
      return Promise.resolve();
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    this.refill();
    if (this.queue.length === 0 && this.tokens >= 0) {
      this.tokens -= bytes;
      this.passed += bytes;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: ThrottleWaiter = { bytes, resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) {
            this.queue.splice(index, 1);
            reject(signal.reason);
          }
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.schedule();
    });
  }

  private burst(): number {
    return (this.bytesPerSecond ?? 0) / 4;
  }

  private refill() {
    const now = this.clock.now();
    if (this.bytesPerSecond !== null) {
      this.tokens = Math.min(this.burst(), this.tokens + ((now - this.last) * this.bytesPerSecond) / 1000);
    }
    this.last = now;
  }

  private grant(waiter: ThrottleWaiter) {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    this.passed += waiter.bytes;
    waiter.resolve();
  }

  private clearTimer() {
    if (this.timer === null) {
      return;
    }

    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    this.clearTimer();
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 0) {
      const waiter = this.queue.shift()!;
      this.tokens -= waiter.bytes;
      this.grant(waiter);
    }
    if (this.queue.length === 0 || this.bytesPerSecond === null) {
      return;
    }
    const waitMs = Math.max(1, Math.ceil((-this.tokens * 1000) / this.bytesPerSecond));
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.schedule();
    }, waitMs);
  }
}
