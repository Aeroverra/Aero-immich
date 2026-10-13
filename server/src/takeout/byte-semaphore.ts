// A FIFO byte budget (single-pass design 6.1, 12): every buffered entry, the readahead of every reader, queued
// write-behind and image decode take their bytes from one process-wide budget. FIFO order means a large request is
// never starved by a stream of small ones. A request larger than the whole budget is admitted when nothing else is
// held. A lease can be shared (write-behind and sampling keep the buffer of an entry alive after its reader moved on):
// the bytes are returned when the last share is released. A holder that does not use its bytes for a while (a paused
// reader) can lend them to the budget and take them back at once when it continues.

interface Waiter {
  bytes: number;
  resolve: (lease: ByteLease) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class Grant {
  refs = 1;
  /** the bytes are lent to the budget: others may hold them until the holder takes them back */
  lent = false;
  constructor(
    readonly semaphore: ByteSemaphore,
    readonly bytes: number,
  ) {}
}

export class ByteLease {
  private released = false;

  constructor(private readonly grant: Grant) {}

  get bytes(): number {
    return this.grant.bytes;
  }

  /** the bytes are lent to the budget (lend) and not taken back yet */
  get lent(): boolean {
    return this.grant.lent;
  }

  /** Another handle on the same bytes; the bytes return to the budget when every handle is released */
  share(): ByteLease {
    if (this.released) {
      throw new Error('share of a released lease');
    }
    this.grant.refs++;
    return new ByteLease(this.grant);
  }

  /**
   * Lend the bytes to the budget while the holder does not use them: requests waiting for bytes may take them. The
   * lease stays the holder's. Idempotent.
   */
  lend(): void {
    if (this.released || this.grant.lent) {
      return;
    }
    this.grant.lent = true;
    this.grant.semaphore.free(this.grant.bytes);
  }

  /**
   * Take lent bytes back. Never waits: the budget may be above its capacity until other holders release theirs,
   * because waiting here could wait on a holder that itself waits for something this holder keeps. Idempotent.
   */
  reclaim(): void {
    if (this.released || !this.grant.lent) {
      return;
    }
    this.grant.lent = false;
    this.grant.semaphore.take(this.grant.bytes);
  }

  /** Idempotent per handle */
  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.grant.refs--;
    if (this.grant.refs === 0 && !this.grant.lent) {
      this.grant.semaphore.free(this.grant.bytes);
    }
  }
}

export class ByteSemaphore {
  private queue: Waiter[] = [];
  held = 0;
  /** highest `held` ever seen, for the accounting tests */
  peak = 0;

  constructor(readonly capacity: number) {}

  get waiting(): number {
    return this.queue.length;
  }

  acquire(bytes: number, signal?: AbortSignal): Promise<ByteLease> {
    const want = Math.max(0, Math.floor(bytes));
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (this.queue.length === 0 && this.fits(want)) {
      return Promise.resolve(this.grant(want));
    }
    return new Promise<ByteLease>((resolve, reject) => {
      const waiter: Waiter = { bytes: want, resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) {
            this.queue.splice(index, 1);
            reject(signal.reason);
            this.admit();
          }
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  /** Synchronous acquire: only when nobody waits and the bytes fit now */
  tryAcquire(bytes: number): ByteLease | null {
    const want = Math.max(0, Math.floor(bytes));
    if (this.queue.length === 0 && this.fits(want)) {
      return this.grant(want);
    }
    return null;
  }

  /** @internal called by the last release of a grant, and when a holder lends its bytes */
  free(bytes: number): void {
    this.held -= bytes;
    this.admit();
  }

  /** @internal called when a holder takes lent bytes back: at once, even above the capacity */
  take(bytes: number): void {
    this.held += bytes;
    this.peak = Math.max(this.peak, this.held);
  }

  private fits(bytes: number): boolean {
    return this.held + bytes <= this.capacity || this.held === 0;
  }

  private grant(bytes: number): ByteLease {
    this.held += bytes;
    this.peak = Math.max(this.peak, this.held);
    return new ByteLease(new Grant(this, bytes));
  }

  private admit(): void {
    while (this.queue.length > 0 && this.fits(this.queue[0].bytes)) {
      const waiter = this.queue.shift()!;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve(this.grant(waiter.bytes));
    }
  }
}
