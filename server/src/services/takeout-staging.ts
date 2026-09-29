import { randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hashTap, isTransportError } from 'src/takeout';

// Content-addressed staging (single-pass design 5): <userFolder>/.staging/<runId>/<hh>/<sha1hex>. The path is
// derived from the run id and never stored. A blob exists under its final name only after its content hashed to that
// name and was fsynced, so "blob present with the expected size" means "content correct".

export const STAGING_DIR = '.staging';
export const STAGING_TTL_MS = 7 * 24 * 3_600_000;
const TMP_DIR = '.tmp';
const TRASH_PREFIX = '.trash-';
/**
 * The cross-device copy writes next to its destination under this suffix, a name derived from the target: a copy cut
 * by a crash is found and removed by whoever reclaims that target (design I4), never left behind under a random name.
 */
export const COPY_TMP_SUFFIX = '.takeout-tmp';
const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const HEX40_RE = /^[\da-f]{40}$/;
const MiB = 1024 * 1024;
const noop = () => {};

export const isUuid = (name: string) => UUID_RE.test(name);

export function stagingRoot(userFolder: string): string {
  return join(userFolder, STAGING_DIR);
}

export function runStagingDir(userFolder: string, runId: string): string {
  return join(stagingRoot(userFolder), runId);
}

/**
 * Every rm, rename or delete of a staging path goes through this check: only <userFolder>/.staging/<uuid> and
 * <userFolder>/.staging/.trash-* are accepted, so a moved media location can never point it at live data.
 */
export function assertStagingPath(userFolder: string, path: string, options: { anyChild?: boolean } = {}): void {
  const rel = relative(stagingRoot(userFolder), path);
  const parts = rel.split(sep);
  const child = rel !== '' && !rel.startsWith('..') && parts.length === 1 && parts[0] !== '.';
  const known = UUID_RE.test(parts[0]) || (parts[0].startsWith(TRASH_PREFIX) && parts[0].length > TRASH_PREFIX.length);
  // the sweep may also remove a stray entry directly under .staging (anyChild), never anything outside it
  const ok = child && (known || options.anyChild === true);
  if (!ok) {
    throw new Error(`refusing to touch ${path}: not a staging directory of ${userFolder}`);
  }
}

/** The file operations the store uses; tests inject faults (ENOENT after a successful rename, EXDEV, ENOSPC) */
export interface StagingFs {
  mkdir: typeof fsp.mkdir;
  readdir: typeof fsp.readdir;
  rename: typeof fsp.rename;
  stat: typeof fsp.stat;
  unlink: typeof fsp.unlink;
  rm: typeof fsp.rm;
  copyFile: typeof fsp.copyFile;
  open: typeof fsp.open;
}

export const nodeStagingFs: StagingFs = {
  mkdir: fsp.mkdir,
  readdir: fsp.readdir,
  rename: fsp.rename,
  stat: fsp.stat,
  unlink: fsp.unlink,
  rm: fsp.rm,
  copyFile: fsp.copyFile,
  open: fsp.open,
};

export interface StagingLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface StagingRepo {
  updateRun(id: string, patch: { hasStaging: boolean }): Promise<void>;
  getRunsSupersededBy(runId: string): Promise<Array<{ id: string }>>;
}

export interface StagingAssets {
  getByIds(ids: string[]): Promise<Array<{ id: string }>>;
}

export interface StagingDeps {
  repo: StagingRepo;
  assets: StagingAssets;
  logger?: StagingLogger;
  fs?: StagingFs;
}

/** A run file row that may point at a file under upload/ */
export interface ReclaimRow {
  id: number | string;
  status: string;
  targetPath: string | null;
  newAssetId: string | null;
  size: number | string | bigint;
  checksum: Buffer | null;
  /** null for rows planned by the old code, which streamed straight into targetPath */
  entrySeq: number | null;
}

export type ReclaimResult = 'asset' | 'staged' | 'unlinked' | 'absent';

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

export async function sha1File(path: string): Promise<Buffer> {
  const tap = hashTap();
  await pipeline(
    createReadStream(path, { highWaterMark: 4 * MiB }),
    tap.stream,
    new Writable({ write: (_c, _e, cb) => cb() }),
  );
  return tap.result().checksum;
}

/** Synchronous check-and-reserve of one content; release() in finally on every failure path */
export class Reservation {
  private state: 'pending' | 'committed' | 'released' = 'pending';

  constructor(
    private readonly store: StagingStore,
    readonly hex: string,
  ) {}

  get pending(): boolean {
    return this.state === 'pending';
  }

  /** @internal after the rename */
  commit(size: number): void {
    if (this.state !== 'pending') {
      return;
    }
    this.state = 'committed';
    this.store.onCommit(this.hex, size);
  }

  release(): void {
    if (this.state !== 'pending') {
      return;
    }
    this.state = 'released';
    this.store.onRelease(this.hex);
  }

  releaseIfPending(): void {
    this.release();
  }
}

export class StagingStore {
  /** committed blobs: hex -> size (null when not known yet: found on disk at open) */
  private committed = new Map<string, number | null>();
  private reserved = new Map<string, Reservation>();
  private readonly fs: StagingFs;
  /** ENOSPC, or a write that failed after transport retries: the first one wins */
  fatal: Error | null = null;
  crossDevice = false;

  private constructor(
    readonly runId: string,
    readonly userFolder: string,
    readonly dir: string,
    private readonly uploadUserDir: string,
    private readonly deps: StagingDeps,
  ) {
    this.fs = deps.fs ?? nodeStagingFs;
  }

  /**
   * Adopt the directory of a run this one superseded (idempotent across crashes), create the run directory, its
   * .tmp and the 256 shards once, drop interrupted temp files, probe for a cross-device upload/ and rebuild the
   * committed set from the directory.
   */
  static async open(
    run: { id: string },
    userFolder: string,
    uploadUserDir: string,
    deps: StagingDeps,
  ): Promise<StagingStore> {
    const fs = deps.fs ?? nodeStagingFs;
    const dir = runStagingDir(userFolder, run.id);
    assertStagingPath(userFolder, dir);
    const store = new StagingStore(run.id, userFolder, dir, uploadUserDir, deps);

    await fs.mkdir(stagingRoot(userFolder), { recursive: true });
    if (!(await store.exists(dir))) {
      for (const old of await deps.repo.getRunsSupersededBy(run.id)) {
        const oldDir = runStagingDir(userFolder, old.id);
        assertStagingPath(userFolder, oldDir);
        if (await store.exists(oldDir)) {
          await fs.rename(oldDir, dir);
          deps.logger?.log(`Takeout run ${run.id} took over the staging of run ${old.id}`);
          break;
        }
      }
    }

    await deps.repo.updateRun(run.id, { hasStaging: true });
    await fs.mkdir(join(dir, TMP_DIR), { recursive: true });
    const shards = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
    for (let i = 0; i < shards.length; i += 16) {
      await Promise.all(shards.slice(i, i + 16).map((shard) => fs.mkdir(join(dir, shard), { recursive: true })));
    }
    for (const name of await fs.readdir(join(dir, TMP_DIR))) {
      await fs.unlink(join(dir, TMP_DIR, name)).catch(noop);
    }
    await store.probeCrossDevice();
    for (const shard of shards) {
      for (const name of await fs.readdir(join(dir, shard))) {
        if (HEX40_RE.test(name) && name.startsWith(shard)) {
          store.committed.set(name, null);
        } else if (name.endsWith(COPY_TMP_SUFFIX)) {
          // a cross-device copy back into staging cut by a crash
          await fs.unlink(join(dir, shard, name)).catch(noop);
        }
      }
    }
    return store;
  }

  blobPath(hex: string): string {
    return join(this.dir, hex.slice(0, 2), hex);
  }

  private tmpPath(): string {
    return join(this.dir, TMP_DIR, randomUUID());
  }

  private async exists(path: string): Promise<boolean> {
    return this.fs
      .stat(path)
      .then(() => true)
      .catch(() => false);
  }

  private async probeCrossDevice() {
    const probe = this.tmpPath();
    const handle = await this.fs.open(probe, 'wx');
    await handle.close();
    try {
      await this.fs.mkdir(this.uploadUserDir, { recursive: true });
      // one fixed name per run: a probe left by a crash between the rename and the unlink goes at the next open
      const target = join(this.uploadUserDir, `.takeout-probe-${this.runId}`);
      await this.fs.unlink(target).catch(noop);
      await this.fs.rename(probe, target);
      await this.fs.unlink(target).catch(noop);
    } catch (error) {
      if (codeOf(error) !== 'EXDEV') {
        throw error;
      }
      this.crossDevice = true;
      await this.fs.unlink(probe).catch(noop);
    }
  }

  // ---------- reservations ----------

  /** committed blob only: used by needed, fetch, repair and finalize */
  hasBlob(hex: string): boolean {
    return this.committed.has(hex);
  }

  /** a write in flight counts: used by the read decisions only */
  hasBlobOrReserved(hex: string): boolean {
    return this.committed.has(hex) || this.reserved.has(hex);
  }

  /** stat (fills the committed size); a blob of the wrong size is unlinked */
  async hasBlobWithSize(hex: string, size: number): Promise<boolean> {
    const st = await this.fs.stat(this.blobPath(hex)).catch(() => null);
    if (!st) {
      this.committed.delete(hex);
      return false;
    }
    if (Number(st.size) !== size) {
      await this.fs.unlink(this.blobPath(hex)).catch(noop);
      this.committed.delete(hex);
      return false;
    }
    this.committed.set(hex, size);
    return true;
  }

  reserve(hex: string): Reservation | null {
    if (this.committed.has(hex) || this.reserved.has(hex)) {
      return null;
    }
    const reservation = new Reservation(this, hex);
    this.reserved.set(hex, reservation);
    return reservation;
  }

  pendingReservations(): number {
    return this.reserved.size;
  }

  /** @internal */
  onCommit(hex: string, size: number) {
    this.reserved.delete(hex);
    this.committed.set(hex, size);
  }

  /** @internal */
  onRelease(hex: string) {
    this.reserved.delete(hex);
  }

  setFatal(error: Error) {
    this.fatal ??= error;
  }

  // ---------- writes ----------

  /** tmp 'wx', write, fsync, close; rename tmp -> blob; commit. Transport errors are retried by the caller. */
  async writeBuffer(reservation: Reservation, buf: Buffer): Promise<void> {
    const tmp = this.tmpPath();
    const handle = await this.fs.open(tmp, 'wx');
    let closed = false;
    try {
      let written = 0;
      while (written < buf.length) {
        const { bytesWritten } = await handle.write(buf, written, buf.length - written);
        written += bytesWritten;
      }
      await handle.sync();
      await handle.close();
      closed = true;
      await this.renameRule(tmp, this.blobPath(reservation.hex), buf.length);
      reservation.commit(buf.length);
    } catch (error) {
      if (!closed) {
        await handle.close().catch(noop);
      }
      await this.fs.unlink(tmp).catch(noop);
      throw error;
    }
  }

  /**
   * Hash and write in one pass (large entries, fetch). On failure the temp file is removed once its descriptor is
   * closed (an NFS client turns the unlink of an open file into a .nfsXXXX leftover).
   */
  async streamToTemp(
    stream: NodeJS.ReadableStream,
    prefix?: Buffer | null,
  ): Promise<{ tmp: string; checksum: Buffer; size: number }> {
    const tmp = this.tmpPath();
    const tap = hashTap();
    const out = createWriteStream(tmp, { flags: 'wx', flush: true, highWaterMark: MiB });
    const closed = new Promise<void>((resolve) => out.once('close', resolve));
    out.on('error', noop);
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
    try {
      await pipeline(source, tap.stream, out);
      await closed;
    } catch (error) {
      out.destroy();
      await closed;
      await this.fs.unlink(tmp).catch(noop);
      throw error;
    }
    const { checksum, size } = tap.result();
    return { tmp, checksum, size };
  }

  async commitTemp(tmp: string, reservation: Reservation, size: number): Promise<void> {
    try {
      await this.renameRule(tmp, this.blobPath(reservation.hex), size);
    } catch (error) {
      await this.fs.unlink(tmp).catch(noop);
      throw error;
    }
    reservation.commit(size);
  }

  async discardTemp(tmp: string): Promise<void> {
    await this.fs.unlink(tmp).catch(noop);
  }

  /**
   * NFS rename rule: a retransmitted RENAME can report ENOENT although it succeeded, so ENOENT with the source gone
   * and the destination present at the expected size counts as success. EXDEV switches this call to the copy path.
   */
  private async renameRule(src: string, dst: string, expectedSize: number | null): Promise<void> {
    try {
      await this.fs.rename(src, dst);
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT') {
        const [from, to] = await Promise.all([
          this.fs.stat(src).catch(() => null),
          this.fs.stat(dst).catch(() => null),
        ]);
        if (!from && to && (expectedSize === null || Number(to.size) === expectedSize)) {
          return;
        }
        throw error;
      }
      if (code === 'EXDEV') {
        this.crossDevice = true;
        await this.copyAcross(src, dst);
        await this.fs.unlink(src).catch(noop);
        return;
      }
      throw error;
    }
  }

  /** A partial copy is never at the target path: copy to the target's temp name, fsync, rename */
  private async copyAcross(src: string, dst: string): Promise<void> {
    const tmp = `${dst}${COPY_TMP_SUFFIX}`;
    try {
      // a copy an earlier attempt left there when it was cut
      await this.fs.unlink(tmp).catch(noop);
      await this.fs.copyFile(src, tmp, constants.COPYFILE_FICLONE);
      const handle = await this.fs.open(tmp, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.fs.rename(tmp, dst);
    } catch (error) {
      await this.fs.unlink(tmp).catch(noop);
      throw error;
    }
  }

  // ---------- finalize and reclaim ----------

  /** rename blob -> targetPath (EXDEV -> copy); 'missing' when the blob is gone */
  async moveTo(hex: string, targetPath: string, size: number | null = null): Promise<'moved' | 'missing'> {
    await this.fs.mkdir(dirname(targetPath), { recursive: true });
    const blob = this.blobPath(hex);
    try {
      await this.renameRule(blob, targetPath, size ?? this.committed.get(hex) ?? null);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') {
        this.committed.delete(hex);
        return 'missing';
      }
      throw error;
    }
    this.committed.delete(hex);
    return 'moved';
  }

  /**
   * The one rule for every asset-less target (single-pass design 5.4): keep it when its asset exists, move it back
   * to staging when it is complete, else unlink it. Where staging is discarded next (finishing, Discard) `how` is
   * 'unlink'.
   */
  async reclaim(row: ReclaimRow, how: 'stage' | 'unlink'): Promise<ReclaimResult> {
    if (!row.targetPath) {
      return 'absent';
    }
    if (row.newAssetId) {
      const [asset] = await this.deps.assets.getByIds([row.newAssetId]);
      if (asset) {
        return 'asset';
      }
    }
    return reclaimFile(this.fs, row, how, this);
  }

  /** @internal used by reclaim: complete target back into this store */
  async adoptTarget(path: string, hex: string, size: number): Promise<void> {
    await this.renameRule(path, this.blobPath(hex), size);
    this.committed.set(hex, size);
  }

  // ---------- accounting and removal ----------

  async bytesHeld(): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    for (const [hex, size] of this.committed) {
      let known = size;
      if (known === null) {
        const st = await this.fs.stat(this.blobPath(hex)).catch(() => null);
        if (!st) {
          this.committed.delete(hex);
          continue;
        }
        known = Number(st.size);
        this.committed.set(hex, known);
      }
      files++;
      bytes += known;
    }
    return { files, bytes };
  }

  /** Rename the run directory to trash, hasStaging = false, delete in the background. Never throws. */
  async discard(): Promise<void> {
    try {
      await this.deps.repo.updateRun(this.runId, { hasStaging: false });
    } catch (error) {
      this.deps.logger?.warn(`Takeout staging of run ${this.runId}: could not clear hasStaging: ${String(error)}`);
    }
    await trashStagingDir(this.userFolder, this.runId, this.fs, this.deps.logger);
    this.committed.clear();
  }
}

async function unlinkIfPresent(fs: StagingFs, path: string): Promise<void> {
  await fs.unlink(path).catch((error: unknown) => {
    if (codeOf(error) !== 'ENOENT') {
      throw error;
    }
  });
}

/** Remove an asset-less target and the cross-device copy of it a crash may have left (design I4) */
export async function unlinkTarget(path: string, fs: StagingFs = nodeStagingFs): Promise<void> {
  await unlinkIfPresent(fs, `${path}${COPY_TMP_SUFFIX}`);
  await unlinkIfPresent(fs, path);
}

/** reclaim without an open store: 'unlink' always, 'stage' when a store is given */
export async function reclaimFile(
  fs: StagingFs,
  row: ReclaimRow,
  how: 'stage' | 'unlink',
  store: StagingStore | null,
): Promise<ReclaimResult> {
  const path = row.targetPath;
  if (!path) {
    return 'absent';
  }
  // a cross-device copy to this target cut by a crash
  await unlinkIfPresent(fs, `${path}${COPY_TMP_SUFFIX}`);
  const st = await fs.stat(path).catch(() => null);
  if (!st) {
    return 'absent';
  }
  const size = Number(row.size);
  const legacy = row.entrySeq === null;
  let complete = Number(st.size) === size && row.checksum !== null;
  if (complete && legacy) {
    // the old code streamed into targetPath in place: only a written row with the right content is whole
    const actual = await sha1File(path).catch(() => null);
    complete = row.status === 'written' && actual?.equals(row.checksum!) === true;
  }
  const hex = row.checksum ? row.checksum.toString('hex') : null;
  // the committed set is a snapshot: the target is dropped as a second copy only when the blob is on disk now
  if (
    how === 'stage' &&
    store &&
    complete &&
    hex &&
    !(store.hasBlob(hex) && (await store.hasBlobWithSize(hex, size)))
  ) {
    await store.adoptTarget(path, hex, size);
    return 'staged';
  }
  await unlinkIfPresent(fs, path);
  return 'unlinked';
}

/** Rename <userFolder>/.staging/<name> to .trash-<name>-<n> and delete it in the background. Never throws. */
export async function trashStagingDir(
  userFolder: string,
  name: string,
  fs: StagingFs = nodeStagingFs,
  logger?: StagingLogger,
  options: { anyChild?: boolean } = {},
): Promise<void> {
  const root = stagingRoot(userFolder);
  const source = join(root, name);
  let trash: string | null = null;
  try {
    assertStagingPath(userFolder, source, options);
    if (name.startsWith(TRASH_PREFIX)) {
      trash = source;
    } else {
      for (let n = 0; n < 1000 && !trash; n++) {
        const candidate = join(root, `${TRASH_PREFIX}${name}-${n}`);
        try {
          await fs.stat(candidate);
        } catch {
          trash = candidate;
        }
      }
      if (!trash) {
        return;
      }
      assertStagingPath(userFolder, trash);
      await fs.rename(source, trash);
    }
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') {
      logger?.warn(`Takeout staging ${source}: could not move to trash: ${String(error)}`);
    }
    return;
  }
  const target = trash;
  void fs.rm(target, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
    // NFS .nfsXXXX silly-rename files of open descriptors: the next sweep retries
    logger?.warn(`Takeout staging ${target}: delete failed, the sweep retries: ${String(error)}`);
  });
}

/** Names directly under <userFolder>/.staging (uuid run directories, trash, anything else) */
export async function listStaging(
  userFolder: string,
  fs: StagingFs = nodeStagingFs,
): Promise<Array<{ name: string; mtimeMs: number }>> {
  const root = stagingRoot(userFolder);
  let names: string[];
  try {
    names = (await fs.readdir(root)) as string[];
  } catch {
    return [];
  }
  const out: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    const st = await fs.stat(join(root, name)).catch(() => null);
    if (st) {
      out.push({ name, mtimeMs: Number(st.mtimeMs) });
    }
  }
  return out;
}

export const isTrashName = (name: string) => name.startsWith(TRASH_PREFIX);

/** Transport errors of a write are retried in place like reads; anything else is returned to the caller */
export async function withTransportRetry<T>(
  fn: () => Promise<T>,
  options: { budgetMs: number; backoffMs?: number[]; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const backoff = options.backoffMs ?? [1000, 2000, 5000, 10_000, 30_000, 60_000];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let streakStart: number | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransportError(error) || options.signal?.aborted) {
        throw error;
      }
      const now = Date.now();
      streakStart ??= now;
      if (now - streakStart >= options.budgetMs) {
        throw error;
      }
      await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
    }
  }
}
