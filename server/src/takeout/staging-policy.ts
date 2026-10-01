// The staging decisions of the reading phase (single-pass design 6.2), pure so they can be tested with 1 KiB limits.

export interface StagingLimits {
  /** entries up to this size are read into memory and hashed before anything is written */
  bufferLimit: number;
  /** images of the sampling set up to this size are buffered too (they need the whole file for the sample) */
  sampleBufferLimit: number;
}

export interface StagingView {
  /** the checksum is on the server (upload assets of the user, trashed included; deleted ones with mode skip) */
  onServer(checksum: Buffer): boolean;
  /** a blob with this checksum is committed or being written in this run */
  hasBlobOrReserved(hex: string): boolean;
  /** quota remaining and free-space budget allow writing this many bytes now, reserved writes included */
  budgetAllows(size: number): boolean;
  limits: StagingLimits;
}

export type ReadMode = 'buffer' | 'probe' | 'hashOnly';

export function hex(checksum: Buffer): string {
  return checksum.toString('hex');
}

export function chooseReadMode(size: number, wantSample: boolean, view: StagingView): ReadMode {
  if (size <= view.limits.bufferLimit) {
    return 'buffer';
  }
  if (wantSample && size <= view.limits.sampleBufferLimit) {
    return 'buffer';
  }
  // cannot be staged now: hash it; it is fetched later only if the plan needs it
  if (!view.budgetAllows(size)) {
    return 'hashOnly';
  }
  return 'probe';
}

/** probe: the first bytes of a large entry match present content of the same size -> only hash it */
export function decideAfterProbe(prefixMatch: boolean): 'stream' | 'hashOnly' {
  return prefixMatch ? 'hashOnly' : 'stream';
}

export type StageDecision = 'serverDuplicate' | 'stagedDuplicate' | 'deferred' | 'stage';

export function decideAfterHash(
  checksum: Buffer,
  size: number,
  mode: 'buffer' | 'stream' | 'hashOnly',
  view: StagingView,
): StageDecision {
  if (view.onServer(checksum)) {
    return 'serverDuplicate';
  }
  if (view.hasBlobOrReserved(hex(checksum))) {
    return 'stagedDuplicate';
  }
  // no bytes to write: fetched later only if planned
  if (mode === 'hashOnly') {
    return 'deferred';
  }
  if (mode === 'buffer' && !view.budgetAllows(size)) {
    return 'deferred';
  }
  // stream mode reserved its budget before it started writing
  return 'stage';
}
