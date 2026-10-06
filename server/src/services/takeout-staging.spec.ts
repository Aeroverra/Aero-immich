import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  assertStagingPath,
  COPY_TMP_SUFFIX,
  nodeStagingFs,
  reclaimFile,
  ReclaimRow,
  runStagingDir,
  StagingFs,
  stagingRoot,
  StagingStore,
  trashStagingDir,
} from 'src/services/takeout-staging';
import { hex } from 'src/takeout';
import { randomBytesSeeded, sha1 } from 'src/takeout/test-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

const errno = (code: string) => Object.assign(new Error(code), { code });

let dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
  dirs = [];
});

interface Setup {
  dir: string;
  userFolder: string;
  uploadDir: string;
  runId: string;
  updates: Array<{ id: string; patch: object }>;
  superseded: Map<string, string[]>;
  assets: Set<string>;
  deps: (fs?: StagingFs) => any;
}

async function setup(): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), 'takeout-staging-'));
  dirs.push(dir);
  const userFolder = join(dir, 'takeouts', 'me');
  await mkdir(userFolder, { recursive: true });
  const updates: Setup['updates'] = [];
  const superseded = new Map<string, string[]>();
  const assets = new Set<string>();
  return {
    dir,
    userFolder,
    uploadDir: join(dir, 'upload', 'user-1'),
    runId: randomUUID(),
    updates,
    superseded,
    assets,
    deps: (fs?: StagingFs) => ({
      repo: {
        updateRun: (id: string, patch: object) => {
          updates.push({ id, patch });
          return Promise.resolve();
        },
        getRunsSupersededBy: (id: string) => Promise.resolve((superseded.get(id) ?? []).map((old) => ({ id: old }))),
      },
      assets: {
        getByIds: (ids: string[]) => Promise.resolve(ids.filter((id) => assets.has(id)).map((id) => ({ id }))),
      },
      fs,
    }),
  };
}

const open = (s: Setup, fs?: StagingFs, runId = s.runId) =>
  StagingStore.open({ id: runId }, s.userFolder, s.uploadDir, s.deps(fs));

async function exists(path: string) {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

const reclaimRow = (over: Partial<ReclaimRow>): ReclaimRow => ({
  id: 1,
  status: 'written',
  targetPath: null,
  newAssetId: 'asset-1',
  size: 0,
  checksum: null,
  entrySeq: 0,
  ...over,
});

async function writeTarget(s: Setup, name: string, content: Buffer) {
  const path = join(s.uploadDir, name);
  await mkdir(s.uploadDir, { recursive: true });
  await writeFile(path, content);
  return path;
}

describe(StagingStore.name, () => {
  it('creates the shards once, drops temp leftovers and rebuilds the committed set', async () => {
    const s = await setup();
    const runDir = runStagingDir(s.userFolder, s.runId);
    const content = randomBytesSeeded(100, 1);
    const h = hex(sha1(content));
    await mkdir(join(runDir, '.tmp'), { recursive: true });
    await writeFile(join(runDir, '.tmp', 'leftover'), 'partial');
    await mkdir(join(runDir, h.slice(0, 2)), { recursive: true });
    await writeFile(join(runDir, h.slice(0, 2), h), content);

    const store = await open(s);
    const listed = await readdir(runDir);
    const shards = listed.filter((name) => name !== '.tmp');
    expect(shards).toHaveLength(256);
    expect(await readdir(join(runDir, '.tmp'))).toEqual([]);
    expect(store.hasBlob(h)).toBe(true);
    expect(s.updates).toContainEqual({ id: s.runId, patch: { hasStaging: true } });
    expect(store.crossDevice).toBe(false);
  });

  it('writes to .tmp and renames: no partial blob is ever visible', async () => {
    const s = await setup();
    const content = randomBytesSeeded(2000, 2);
    const h = hex(sha1(content));
    let blobPath = '';
    const seen: string[] = [];
    const fs: StagingFs = {
      ...nodeStagingFs,
      rename: (async (from: string, to: string) => {
        if (to === blobPath) {
          const blobThere = await exists(to);
          const tmpContent = await readFile(from);
          seen.push(`blob exists before rename: ${blobThere}`, `tmp complete: ${tmpContent.equals(content)}`);
        }
        return nodeStagingFs.rename(from, to);
      }) as StagingFs['rename'],
    };
    const store = await open(s, fs);
    blobPath = store.blobPath(h);
    const reservation = store.reserve(h)!;
    await store.writeBuffer(reservation, content);
    expect(seen).toEqual(['blob exists before rename: false', 'tmp complete: true']);
    expect(await readFile(blobPath)).toEqual(content);
    expect(store.hasBlob(h)).toBe(true);
    expect(store.pendingReservations()).toBe(0);
  });

  it('reserves exclusively; hasBlob ignores reservations, hasBlobOrReserved does not', async () => {
    const s = await setup();
    const store = await open(s);
    const h = hex(sha1(Buffer.from('x')));
    const first = store.reserve(h);
    expect(first).not.toBeNull();
    expect(store.reserve(h)).toBeNull();
    expect(store.hasBlob(h)).toBe(false);
    expect(store.hasBlobOrReserved(h)).toBe(true);
    first!.release();
    expect(store.hasBlobOrReserved(h)).toBe(false);
    expect(store.reserve(h)).not.toBeNull();
  });

  it('releases the reservation of a failed write, so the next same-content entry is written', async () => {
    const s = await setup();
    let fail = false;
    const fs: StagingFs = {
      ...nodeStagingFs,
      open: (async (path: string, flags: string) => {
        const handle = await nodeStagingFs.open(path, flags);
        if (fail && flags === 'wx' && path.includes('.tmp')) {
          fail = false;
          return Object.assign(handle, { write: () => Promise.reject(errno('EIO')) });
        }
        return handle;
      }) as any,
    };
    const store = await open(s, fs);
    fail = true;
    const content = randomBytesSeeded(100, 3);
    const h = hex(sha1(content));
    const reservation = store.reserve(h)!;
    await expect(store.writeBuffer(reservation, content)).rejects.toMatchObject({ code: 'EIO' });
    reservation.releaseIfPending();
    expect(store.pendingReservations()).toBe(0);
    expect(await readdir(join(store.dir, '.tmp'))).toEqual([]);

    const again = store.reserve(h)!;
    await store.writeBuffer(again, content);
    expect(store.hasBlob(h)).toBe(true);
  });

  it('removes the temp file of a failed stream after its descriptor closed', async () => {
    const s = await setup();
    const store = await open(s);
    const failing: Readable = new Readable({
      read: () => {
        failing.push(Buffer.alloc(100));
        failing.destroy(errno('EIO'));
      },
    });
    await expect(store.streamToTemp(failing)).rejects.toMatchObject({ code: 'EIO' });
    expect(await readdir(join(store.dir, '.tmp'))).toEqual([]);
  });

  it('counts a rename that reports ENOENT but happened as a success', async () => {
    const s = await setup();
    const fs: StagingFs = {
      ...nodeStagingFs,
      rename: (async (from: string, to: string) => {
        await nodeStagingFs.rename(from, to);
        if (!to.includes('.takeout-probe')) {
          throw errno('ENOENT');
        }
      }) as StagingFs['rename'],
    };
    const store = await open(s, fs);
    const content = randomBytesSeeded(300, 4);
    const h = hex(sha1(content));
    await store.writeBuffer(store.reserve(h)!, content);
    expect(store.hasBlob(h)).toBe(true);
    expect(await readFile(store.blobPath(h))).toEqual(content);
  });

  it('copies through a temp name, fsyncs, renames and unlinks when a rename crosses devices', async () => {
    const s = await setup();
    let crossed = 0;
    const fs: StagingFs = {
      ...nodeStagingFs,
      rename: (async (from: string, to: string) => {
        if (from.includes('.staging') && to.startsWith(s.uploadDir)) {
          crossed++;
          throw errno('EXDEV');
        }
        return nodeStagingFs.rename(from, to);
      }) as StagingFs['rename'],
    };
    const store = await open(s, fs);
    expect(store.crossDevice).toBe(true);
    const content = randomBytesSeeded(500, 5);
    const h = hex(sha1(content));
    await store.writeBuffer(store.reserve(h)!, content);
    const target = join(s.uploadDir, 'ab', 'cd', 'asset.mp4');
    expect(await store.moveTo(h, target, content.length)).toBe('moved');
    expect(await readFile(target)).toEqual(content);
    expect(await exists(store.blobPath(h))).toBe(false);
    const listed = await readdir(join(s.uploadDir, 'ab', 'cd'));
    expect(listed).toEqual(['asset.mp4']);
    expect(crossed).toBeGreaterThanOrEqual(2);
  });

  it('copies across devices under a name derived from the target, so a copy cut by a crash is found (I4)', async () => {
    const s = await setup();
    const fs: StagingFs = {
      ...nodeStagingFs,
      rename: (async (from: string, to: string) => {
        if (from.includes('.staging') && to.startsWith(s.uploadDir)) {
          throw errno('EXDEV');
        }
        return nodeStagingFs.rename(from, to);
      }) as StagingFs['rename'],
    };
    const store = await open(s, fs);
    const content = randomBytesSeeded(500, 40);
    const h = hex(sha1(content));
    await store.writeBuffer(store.reserve(h)!, content);
    const target = join(s.uploadDir, 'ab', 'cd', 'asset.mp4');
    // an earlier attempt died during the copy
    await mkdir(join(s.uploadDir, 'ab', 'cd'), { recursive: true });
    await writeFile(`${target}${COPY_TMP_SUFFIX}`, 'partial');
    expect(await store.moveTo(h, target, content.length)).toBe('moved');
    expect(await readdir(join(s.uploadDir, 'ab', 'cd'))).toEqual(['asset.mp4']);

    // a crash between the copy and the rename: reclaim of that target removes the partial copy too
    await writeFile(`${target}${COPY_TMP_SUFFIX}`, 'partial');
    await rm(target);
    expect(
      await reclaimFile(
        nodeStagingFs,
        reclaimRow({ targetPath: target, size: 500, checksum: sha1(content) }),
        'unlink',
        null,
      ),
    ).toBe('absent');
    expect(await readdir(join(s.uploadDir, 'ab', 'cd'))).toEqual([]);
  });

  it('probes the upload folder under one name per run and removes a probe a crash left', async () => {
    const s = await setup();
    await mkdir(s.uploadDir, { recursive: true });
    await writeFile(join(s.uploadDir, `.takeout-probe-${s.runId}`), '');
    const seen: string[] = [];
    const fs: StagingFs = {
      ...nodeStagingFs,
      rename: (async (from: string, to: string) => {
        seen.push(to);
        return nodeStagingFs.rename(from, to);
      }) as StagingFs['rename'],
    };
    await open(s, fs);
    expect(seen).toContain(join(s.uploadDir, `.takeout-probe-${s.runId}`));
    expect(await readdir(s.uploadDir)).toEqual([]);
  });

  it('reports a vanished blob as missing', async () => {
    const s = await setup();
    const store = await open(s);
    const content = randomBytesSeeded(100, 6);
    const h = hex(sha1(content));
    await store.writeBuffer(store.reserve(h)!, content);
    await rm(store.blobPath(h));
    expect(await store.moveTo(h, join(s.uploadDir, 'x', 'y', 'z.mp4'))).toBe('missing');
    expect(store.hasBlob(h)).toBe(false);
  });

  describe('reclaim', () => {
    it('never touches the file of an asset that exists', async () => {
      const s = await setup();
      s.assets.add('asset-1');
      const store = await open(s);
      const content = randomBytesSeeded(100, 7);
      const path = await writeTarget(s, 'a.mp4', content);
      expect(await store.reclaim(reclaimRow({ targetPath: path, size: 100, checksum: sha1(content) }), 'stage')).toBe(
        'asset',
      );
      expect(await exists(path)).toBe(true);
    });

    it('moves a complete target back into staging', async () => {
      const s = await setup();
      const store = await open(s);
      const content = randomBytesSeeded(100, 8);
      const path = await writeTarget(s, 'b.mp4', content);
      expect(await store.reclaim(reclaimRow({ targetPath: path, size: 100, checksum: sha1(content) }), 'stage')).toBe(
        'staged',
      );
      expect(await exists(path)).toBe(false);
      expect(store.hasBlob(hex(sha1(content)))).toBe(true);
      expect(await readFile(store.blobPath(hex(sha1(content))))).toEqual(content);
    });

    it('unlinks a target of the wrong size', async () => {
      const s = await setup();
      const store = await open(s);
      const content = randomBytesSeeded(100, 9);
      const path = await writeTarget(s, 'c.mp4', content.subarray(0, 60));
      expect(await store.reclaim(reclaimRow({ targetPath: path, size: 100, checksum: sha1(content) }), 'stage')).toBe(
        'unlinked',
      );
      expect(await exists(path)).toBe(false);
    });

    it('re-hashes legacy rows: a written file with the right content is staged, a wrong one unlinked', async () => {
      const s = await setup();
      const store = await open(s);
      const good = randomBytesSeeded(100, 10);
      const goodPath = await writeTarget(s, 'd.mp4', good);
      expect(
        await store.reclaim(
          reclaimRow({ targetPath: goodPath, size: 100, checksum: sha1(good), entrySeq: null }),
          'stage',
        ),
      ).toBe('staged');

      const bad = randomBytesSeeded(100, 11);
      const badPath = await writeTarget(s, 'e.mp4', bad);
      expect(
        await store.reclaim(
          reclaimRow({ targetPath: badPath, size: 100, checksum: sha1(Buffer.from('other')), entrySeq: null }),
          'stage',
        ),
      ).toBe('unlinked');
      expect(await exists(badPath)).toBe(false);
    });

    it('unlinks a legacy planned target (always a partial stream)', async () => {
      const s = await setup();
      const store = await open(s);
      const content = randomBytesSeeded(100, 12);
      const path = await writeTarget(s, 'f.mp4', content);
      expect(
        await store.reclaim(
          reclaimRow({ targetPath: path, size: 100, checksum: sha1(content), entrySeq: null, status: 'planned' }),
          'stage',
        ),
      ).toBe('unlinked');
    });

    it('never drops the only copy when the committed set of the store is stale', async () => {
      const s = await setup();
      // the job's store stages a blob; a second store opened on the same directory sees it committed
      const job = await open(s);
      const content = randomBytesSeeded(1000, 41);
      const h = hex(sha1(content));
      await job.writeBuffer(job.reserve(h)!, content);
      const other = await open(s);
      expect(other.hasBlob(h)).toBe(true);
      // the job moves the blob to its target; the other store reclaims that target
      const target = join(s.uploadDir, 'aa', 'bb', 'asset-2.jpg');
      expect(await job.moveTo(h, target, content.length)).toBe('moved');
      expect(
        await other.reclaim(
          reclaimRow({ targetPath: target, newAssetId: 'asset-2', size: 1000, checksum: sha1(content) }),
          'stage',
        ),
      ).toBe('staged');
      expect(await readFile(other.blobPath(h))).toEqual(content);
    });

    it('unlinks when asked to, and reports an absent target', async () => {
      const s = await setup();
      const store = await open(s);
      const content = randomBytesSeeded(100, 13);
      const path = await writeTarget(s, 'g.mp4', content);
      expect(await store.reclaim(reclaimRow({ targetPath: path, size: 100, checksum: sha1(content) }), 'unlink')).toBe(
        'unlinked',
      );
      expect(await store.reclaim(reclaimRow({ targetPath: path, size: 100, checksum: sha1(content) }), 'stage')).toBe(
        'absent',
      );
    });
  });

  it('discards to trash and returns even when the delete fails', async () => {
    const s = await setup();
    const fs: StagingFs = {
      ...nodeStagingFs,
      rm: (() => Promise.reject(errno('EBUSY'))) as any,
    };
    const store = await open(s, fs);
    await store.writeBuffer(store.reserve(hex(sha1(Buffer.from('a'))))!, Buffer.from('a'));
    await store.discard();
    const names = await readdir(stagingRoot(s.userFolder));
    expect(names.includes(s.runId)).toBe(false);
    expect(names.some((name) => name.startsWith(`.trash-${s.runId}`))).toBe(true);
    expect(s.updates).toContainEqual({ id: s.runId, patch: { hasStaging: false } });
  });

  it('deletes trash in the background', async () => {
    const s = await setup();
    const store = await open(s);
    await store.discard();
    for (let i = 0; i < 50; i++) {
      const left = await readdir(stagingRoot(s.userFolder));
      if (left.length === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await readdir(stagingRoot(s.userFolder))).toEqual([]);
  });

  it('refuses paths outside .staging/<uuid> and .staging/.trash-*', async () => {
    const s = await setup();
    expect(() => assertStagingPath(s.userFolder, join(s.userFolder, 'takeout-001.zip'))).toThrow();
    expect(() => assertStagingPath(s.userFolder, stagingRoot(s.userFolder))).toThrow();
    expect(() => assertStagingPath(s.userFolder, join(stagingRoot(s.userFolder), 'not-a-uuid'))).toThrow();
    expect(() => assertStagingPath(s.userFolder, join(stagingRoot(s.userFolder), s.runId, 'ab'))).toThrow();
    expect(() => assertStagingPath(s.userFolder, join(stagingRoot(s.userFolder), '..', '..'))).toThrow();
    expect(() => assertStagingPath(s.userFolder, join(stagingRoot(s.userFolder), s.runId))).not.toThrow();
    expect(() => assertStagingPath(s.userFolder, join(stagingRoot(s.userFolder), '.trash-x-0'))).not.toThrow();
    await expect(trashStagingDir(s.userFolder, '../../etc')).resolves.toBeUndefined();
  });

  it('adopts the directory of the run it superseded, once', async () => {
    const s = await setup();
    const oldId = randomUUID();
    const old = await open(s, undefined, oldId);
    const content = randomBytesSeeded(100, 14);
    const h = hex(sha1(content));
    await old.writeBuffer(old.reserve(h)!, content);

    s.superseded.set(s.runId, [oldId]);
    const adopted = await open(s);
    expect(adopted.hasBlob(h)).toBe(true);
    expect(await exists(runStagingDir(s.userFolder, oldId))).toBe(false);

    const again = await open(s);
    expect(again.hasBlob(h)).toBe(true);
  });

  it('adds up the bytes it holds', async () => {
    const s = await setup();
    const store = await open(s);
    await store.writeBuffer(store.reserve(hex(sha1(Buffer.from('aa'))))!, Buffer.from('aa'));
    await store.writeBuffer(store.reserve(hex(sha1(Buffer.from('bbb'))))!, Buffer.from('bbb'));
    const reopened = await open(s);
    expect(await reopened.bytesHeld()).toEqual({ files: 2, bytes: 5 });
  });
});
