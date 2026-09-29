import { getEventListeners } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { StorageCore } from 'src/cores/storage.core';
import {
  AlbumUserRole,
  AssetStatus,
  AssetType,
  DeletedReimportMode,
  JobName,
  JobStatus,
  QueueName,
  TakeoutCatalogStatus,
  TakeoutRunFileAction,
  TakeoutRunFileStatus,
  TakeoutRunStatus,
  UserMetadataKey,
} from 'src/enum';
import { LifecycleDeps, cleanupCancelledRun, discardRunStaging } from 'src/services/takeout-lifecycle';
import { mapRun } from 'src/services/takeout-mappers';
import {
  CATALOG_VERSION,
  DEFAULT_READ_LIMITS,
  LeaseLost,
  ReadLimits,
  createProcessResources,
  sha1,
} from 'src/services/takeout-read';
import { TakeoutRunService } from 'src/services/takeout-run.service';
import { StagingFs, nodeStagingFs, runStagingDir } from 'src/services/takeout-staging';
import { TakeoutService } from 'src/services/takeout.service';
import { FileSourceFs, TakeoutSettings, hex, mergeSettings, nodeFileSourceFs } from 'src/takeout';
import { buildTar, buildTarGz, buildZip, randomBytesSeeded } from 'src/takeout/test-fixtures';
import { TakeoutMemoryRepository } from 'test/fixtures/takeout-memory.repository';
import { ServiceMocks, newTestService } from 'test/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

const KiB = 1024;
const userId = 'user-1';
const media = (name: string) => `Takeout/Google Photos/${name}`;
const errno = (code: string) => Object.assign(new Error(code), { code });
const greyJpeg = (shade: number) =>
  sharp({ create: { width: 400, height: 400, channels: 3, background: { r: shade, g: shade, b: shade } } })
    .jpeg()
    .toBuffer();

const testLimits = (over: Partial<ReadLimits> = {}): ReadLimits => ({
  ...DEFAULT_READ_LIMITS,
  readers: 2,
  bufferLimit: 1 * KiB,
  sampleBufferLimit: 4 * KiB,
  probeBytes: 256,
  readChunk: 4 * KiB,
  readaheadDepth: 2,
  memoryBudget: 1024 * KiB,
  flushRows: 3,
  zipSeekGap: 1 * KiB,
  freeSpaceReserve: 0,
  transportRetryBudgetMs: 0,
  ioRetries: [],
  cancelReaderCapMs: 200,
  cancelWriteCapMs: 200,
  stableAgeMs: -60_000,
  throttleMBps: null,
  ...over,
});

let dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
  dirs = [];
});

interface RunHarness {
  dir: string;
  folder: string;
  repo: TakeoutMemoryRepository;
  sut: TakeoutRunService;
  mocks: ServiceMocks;
  exportId: string;
  settings: TakeoutSettings;
  addPart: (fileName: string, bytes: Buffer, partNumber?: number) => Promise<any>;
  newRun: (over?: Record<string, unknown>) => any;
  execute: (run: { id: string; attempt?: number }) => Promise<JobStatus>;
  run: (id: string) => any;
  files: (runId: string) => any[];
}

async function harness(
  options: { settings?: Partial<TakeoutSettings>; limits?: Partial<ReadLimits>; fs?: FileSourceFs } = {},
): Promise<RunHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'takeout-run-'));
  dirs.push(dir);
  const repo = new TakeoutMemoryRepository();
  repo.addFolder(userId, 'me');
  const folder = join(dir, 'takeouts', 'me');
  await mkdir(folder, { recursive: true });
  const exp = repo.addExport({ userId });
  const { sut, mocks } = newTestService(TakeoutRunService, { takeout: repo as any });
  StorageCore.setMediaLocation(dir);
  const assets = repo.assetRepository();
  mocks.asset.getByIds.mockImplementation(assets.getByIds as any);
  mocks.asset.create.mockImplementation(assets.create as any);
  mocks.asset.getUploadAssetIdByChecksum.mockImplementation(assets.getUploadAssetIdByChecksum as any);
  mocks.metadata.readTags.mockResolvedValue({} as any);
  mocks.metadata.writeTags.mockResolvedValue(true as any);
  mocks.user.get.mockResolvedValue({ quotaSizeInBytes: null, quotaUsageInBytes: 0 } as any);
  mocks.user.getMetadata.mockResolvedValue([]);
  mocks.notification.create.mockResolvedValue({} as any);
  mocks.job.removeJob.mockResolvedValue();
  mocks.job.queue.mockResolvedValue();
  mocks.job.queueAll.mockResolvedValue();
  mocks.event.emit.mockResolvedValue();
  const limits = testLimits(options.limits);
  sut.readLimits = limits;
  sut.processResources = createProcessResources(limits);
  sut.archiveFs = options.fs;
  const settings = mergeSettings({
    includeUnmatched: true,
    syncAlbums: false,
    sessionTag: false,
    takeoutTag: false,
    peopleTags: false,
    googlePhotosFields: false,
    applyRotation: false,
    customTags: [],
    ...options.settings,
  });
  return {
    dir,
    folder,
    repo,
    sut,
    mocks,
    exportId: exp.id,
    settings,
    addPart: async (fileName, bytes, partNumber = 1) => {
      const path = join(folder, fileName);
      await writeFile(path, bytes);
      const st = await stat(path);
      return repo.addPart({
        exportId: exp.id,
        userId,
        fileName,
        partNumber,
        size: st.size,
        mtime: st.mtime,
        ctime: st.ctime,
        prevSyncSize: st.size,
      });
    },
    newRun: (over = {}) => repo.addRun({ userId, exportId: exp.id, settings, ...over }),
    execute: (run) => sut.handleRun({ runId: run.id, attempt: run.attempt ?? 0 }),
    run: (id) => repo.runs.find((r) => r.id === id),
    files: (runId) => repo.runFiles.filter((f) => f.runId === runId).toSorted((a, b) => a.seq - b.seq),
  };
}

const lifecycleOf = (h: RunHarness): LifecycleDeps => ({
  takeout: h.repo as any,
  asset: h.mocks.asset as any,
  job: h.mocks.job as any,
  websocket: h.mocks.websocket as any,
  logger: { log: () => {}, warn: () => {}, error: () => {} } as any,
});

const unique = (values: string[]) => values.filter((value, i) => i === 0 || values[i - 1] !== value);

async function exists(path: string) {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

/** a first attempt of a run that stopped right after the rename of the blob to its target */
async function plannedUpload(h: RunHarness, content: Buffer) {
  await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz([{ name: media('a.mp4'), data: content }]));
  const run = h.newRun({ status: TakeoutRunStatus.Failed, attempt: 0 });
  // a first attempt that stopped right after the rename of the blob to its target
  await h.repo.insertRunFiles([
    {
      runId: run.id,
      seq: 0,
      takeoutPath: media('a.mp4'),
      partName: 'takeout-20260914T211500Z-1-001.tgz',
      entrySeq: 0,
      size: content.length,
      checksum: sha1(content),
      fileKind: 'video',
      action: TakeoutRunFileAction.Upload,
      status: TakeoutRunFileStatus.Planned,
      groupIndex: 0,
      groupOrder: 0,
      groupKind: 'none',
      isCover: true,
      newAssetId: '00000000-0000-4000-8000-000000000001',
      plan: {},
    },
  ]);
  const target = join(h.dir, 'upload', userId, 'target.mp4');
  await mkdir(join(h.dir, 'upload', userId), { recursive: true });
  return { run, target };
}

/** A run of two files, the first of which the user permanently deleted before */
async function importWithDeleted(mode: DeletedReimportMode) {
  const h = await harness();
  const deleted = randomBytesSeeded(500, 70);
  const other = randomBytesSeeded(700, 71);
  await h.addPart(
    'takeout-20260914T211500Z-1-001.tgz',
    buildTarGz([
      { name: media('a.mp4'), data: deleted },
      { name: media('b.mp4'), data: other },
    ]),
  );
  h.mocks.user.getMetadata.mockResolvedValue([
    { key: UserMetadataKey.Preferences, value: { deletedReimport: { mode } } },
  ]);
  h.mocks.assetDeletedChecksum.get.mockImplementation((_userId, checksum) =>
    Promise.resolve(
      checksum.equals(sha1(deleted))
        ? { assetId: 'deleted-asset', originalFileName: 'a.mp4', deletedAt: new Date() }
        : undefined,
    ),
  );
  h.mocks.album.create.mockResolvedValue({ id: 'album-prev' } as any);
  const run = h.newRun();
  expect(await h.execute(run)).toBe(JobStatus.Success);
  const row = h.files(run.id).find((f) => f.takeoutPath === media('a.mp4'));
  const asset = h.repo.assets.find((a) => a.checksum.equals(sha1(deleted)));
  return { h, run: h.run(run.id), row, asset, checksum: sha1(deleted) };
}

const reimports = (h: RunHarness) =>
  h.mocks.event.emit.mock.calls.filter(([name]) => name === 'AssetDeletedReimport').map(([, arg]) => arg);

describe('TakeoutRunService phases (single-pass design 17.2.3)', () => {
  it('reads, plans, imports and finishes in order, and removes its staging', async () => {
    const h = await harness();
    const a = randomBytesSeeded(500, 1);
    const b = randomBytesSeeded(600, 2);
    await h.addPart(
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([
        { name: media('a.mp4'), data: a },
        { name: media('b.mp4'), data: b },
      ]),
    );
    const run = h.newRun();
    expect(await h.execute(run)).toBe(JobStatus.Success);

    expect(unique(h.repo.statusLog)).toEqual(['reading', 'planning', 'importing', 'finishing', 'completed']);
    expect(h.run(run.id).status).toBe(TakeoutRunStatus.Completed);
    expect(h.repo.assets).toHaveLength(2);
    for (const asset of h.repo.assets) {
      expect(asset.originalPath.startsWith(join(h.dir, 'upload', userId))).toBe(true);
      expect(await exists(asset.originalPath)).toBe(true);
    }
    expect(await exists(runStagingDir(h.folder, run.id))).toBe(false);
    expect(h.run(run.id).hasStaging).toBe(false);
    const stats = h.run(run.id).readStats;
    expect(Object.values(stats.parts).map((p: any) => [p.status, p.passes])).toEqual([['read', 1]]);
    expect(h.run(run.id).archiveBytesRead).toBe(h.run(run.id).archiveBytesTotal);
  });

  it('fetches only when a planned upload has no blob', async () => {
    const size = 3 * KiB;
    const server = randomBytesSeeded(size, 3);
    const content = Buffer.concat([server.subarray(0, 512), randomBytesSeeded(size - 512, 4)]);
    const h = await harness();
    await writeFile(join(h.dir, 'server.mp4'), server);
    h.repo.addAsset({
      ownerId: userId,
      checksum: sha1(server),
      originalPath: join(h.dir, 'server.mp4'),
      fileSizeInByte: size,
    });
    await h.addPart(
      'takeout-20260914T211500Z-1-001.zip',
      buildZip([{ nameBytes: Buffer.from(media('big.mp4')), data: content, method: 0 }]),
    );
    const run = h.newRun();
    expect(await h.execute(run)).toBe(JobStatus.Success);
    expect(unique(h.repo.statusLog)).toEqual([
      'reading',
      'planning',
      'fetching',
      'importing',
      'finishing',
      'completed',
    ]);
    const created = h.repo.assets.find((asset) => asset.checksum.equals(sha1(content)))!;
    expect(await readFile(created.originalPath)).toEqual(content);
    const stats = h.run(run.id).readStats;
    expect(stats.fetchFiles).toBe(1);
    // the zip directory and the readahead are read too: the total takes what the fetch really read
    expect(stats.fetchBytesRead).toBeGreaterThan(0);
    expect(stats.fetchBytesRead).toBe(stats.fetchBytesTotal);
    expect(Object.values(stats.parts).map((p: any) => p.fetchBytesRead)).toEqual([stats.fetchBytesRead]);
  });

  it('does nothing for a stale job of a final run, and the lease refuses final runs', async () => {
    const h = await harness();
    for (const status of [TakeoutRunStatus.Failed, TakeoutRunStatus.Cancelled, TakeoutRunStatus.Completed]) {
      const run = h.newRun({ status });
      expect(await h.execute(run)).toBe(JobStatus.Skipped);
      expect(h.run(run.id).status).toBe(status);
      expect(await h.repo.takeLease(run.id, 'token')).toBe(false);
    }
    expect(h.repo.calls.setRunStatusCas ?? 0).toBe(0);
  });

  it('stops without writing when a status check-and-set finds the lease lost', async () => {
    const h = await harness();
    await h.addPart(
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([{ name: media('a.mp4'), data: randomBytesSeeded(100, 5) }]),
    );
    const run = h.newRun();
    const original = h.repo.setRunStatusCas.bind(h.repo);
    vi.spyOn(h.repo, 'setRunStatusCas').mockImplementation((id, token, status, patch) => {
      if (status === TakeoutRunStatus.Reading) {
        // another worker took the run meanwhile
        h.repo.runs.find((r) => r.id === id)!.leaseToken = 'someone-else';
      }
      return original(id, token, status, patch);
    });
    expect(await h.execute(run)).toBe(JobStatus.Skipped);
    expect(h.run(run.id).status).toBe(TakeoutRunStatus.Queued);
    expect(h.repo.entries).toEqual([]);
  });

  it('ends a run whose reader failed as failed, with its parts partial, not stuck in reading', async () => {
    const fs: FileSourceFs = {
      open: async (path) => {
        const real = await nodeFileSourceFs.open(path);
        return {
          read: () => Promise.reject(Object.assign(new Error('input/output error'), { code: 'EIO' })),
          stat: () => real.stat(),
          close: () => real.close(),
        };
      },
    };
    const h = await harness({ fs });
    await h.addPart(
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([{ name: media('a.mp4'), data: randomBytesSeeded(100, 6) }]),
    );
    const run = h.newRun();
    expect(await h.execute(run)).toBe(JobStatus.Failed);
    expect(h.run(run.id).status).toBe(TakeoutRunStatus.Failed);
    expect(h.run(run.id).error).toMatch(/Could not read/);
    expect(h.repo.parts[0].catalogStatus).toBe(TakeoutCatalogStatus.Partial);
    expect(h.run(run.id).leaseToken).toBeNull();
    expect(h.mocks.job.queue).toHaveBeenCalledWith({ name: 'TakeoutAnalyzeExport', data: { exportId: h.exportId } });
    // the parts table of the stopped run shows the part waiting for Resume, not still being read
    const [ps] = Object.values(h.run(run.id).readStats.parts) as any[];
    expect(ps.status).toBe('pending');
    expect(ps.finishedAt).not.toBeNull();
  });

  it('fails a run whose read is stuck longer than the stall limit', async () => {
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    const fs: FileSourceFs = {
      open: async (path) => {
        const real = await nodeFileSourceFs.open(path);
        return {
          read: async (buffer, offset, length, position) => {
            await stuck;
            return real.read(buffer, offset, length, position);
          },
          stat: () => real.stat(),
          close: () => real.close(),
        };
      },
    };
    const h = await harness({ fs, limits: { readStallMs: 50 } });
    await h.addPart(
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([{ name: media('a.mp4'), data: randomBytesSeeded(100, 7) }]),
    );
    const run = h.newRun();
    const done = h.execute(run);
    // the 2 s progress tick runs the stall watchdog
    expect(await done).toBe(JobStatus.Failed);
    release();
    expect(h.run(run.id).error).toMatch(/stalled/);
  }, 10_000);

  it('fails a stalled run although statfs of the staging share hangs as well (I9)', async () => {
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    const fs: FileSourceFs = {
      open: async (path) => {
        const real = await nodeFileSourceFs.open(path);
        return {
          read: async (buffer, offset, length, position) => {
            await stuck;
            return real.read(buffer, offset, length, position);
          },
          stat: () => real.stat(),
          close: () => real.close(),
        };
      },
    };
    const h = await harness({ fs, limits: { readStallMs: 50 } });
    // the staging folder sits on the same share: statfs answers once, then never again
    let statfsCalls = 0;
    h.sut.diskAvailable = () => (statfsCalls++ === 0 ? Promise.resolve(1e12) : new Promise(() => {}));
    await h.addPart(
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([{ name: media('a.mp4'), data: randomBytesSeeded(100, 60) }]),
    );
    const run = h.newRun();
    expect(await h.execute(run)).toBe(JobStatus.Failed);
    release();
    expect(h.run(run.id).error).toMatch(/stalled/);
    expect(h.run(run.id).leaseToken).toBeNull();
  }, 10_000);

  it('fails a run whose fetch read stalls (I9)', async () => {
    let opens = 0;
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    const fs: FileSourceFs = {
      open: async (path) => {
        const real = await nodeFileSourceFs.open(path);
        // 1: central directory for the sampling set, 2: the read of the part, 3: the fetch
        const hang = ++opens >= 3;
        return {
          read: async (buffer, offset, length, position) => {
            if (hang) {
              await stuck;
            }
            return real.read(buffer, offset, length, position);
          },
          stat: () => real.stat(),
          close: () => real.close(),
        };
      },
    };
    const size = 3 * KiB;
    const server = randomBytesSeeded(size, 61);
    const content = Buffer.concat([server.subarray(0, 512), randomBytesSeeded(size - 512, 62)]);
    const h = await harness({ fs, limits: { readStallMs: 50 } });
    await writeFile(join(h.dir, 'server.mp4'), server);
    h.repo.addAsset({
      ownerId: userId,
      checksum: sha1(server),
      originalPath: join(h.dir, 'server.mp4'),
      fileSizeInByte: size,
    });
    await h.addPart(
      'takeout-20260914T211500Z-1-001.zip',
      buildZip([{ nameBytes: Buffer.from(media('big.mp4')), data: content, method: 0 }]),
    );
    h.sut.diskAvailable = () => Promise.resolve(1e12);
    const run = h.newRun();
    expect(await h.execute(run)).toBe(JobStatus.Failed);
    release();
    expect(h.repo.statusLog).toContain('fetching');
    expect(h.run(run.id).error).toMatch(/stalled/);
  }, 10_000);

  it('never waits forever for decode memory while buffers and readahead hold the budget (6.5)', async () => {
    // two paired images whose decode (400 x 400 x 4 bytes) is larger than the whole buffer budget
    const h = await harness({ limits: { readers: 1, sampleBufferLimit: 64 * KiB, memoryBudget: 256 * KiB } });
    await h.addPart(
      'takeout-20260914T211500Z-1-001.zip',
      buildZip([
        { nameBytes: Buffer.from(media('big.jpg')), data: await greyJpeg(128), method: 0 },
        { nameBytes: Buffer.from(media('big-edited.jpg')), data: await greyJpeg(112), method: 0 },
        { nameBytes: Buffer.from(media('c.mp4')), data: randomBytesSeeded(500, 63), method: 0 },
      ]),
    );
    const run = h.newRun();
    expect(await h.execute(run)).toBe(JobStatus.Success);
    const sampled = h.repo.entries.filter((e) => e.path.endsWith('.jpg'));
    expect(sampled.map((e) => [e.width, e.height, e.sampleSkipped])).toEqual([
      [400, 400, null],
      [400, 400, null],
    ]);
    expect(h.sut.processResources!.memory.held).toBe(0);
  }, 10_000);

  it('reads the index archive once per attempt (sampling set and planning)', async () => {
    let indexOpens = 0;
    const fs: FileSourceFs = {
      open: (path) => {
        if (path.endsWith('index.tgz')) {
          indexOpens++;
        }
        return nodeFileSourceFs.open(path);
      },
    };
    const h = await harness({ fs });
    const html = [
      '<div id="service-details-PHOTOS" class="service-detail"><h1>Google Photos</h1>',
      '<div class="file-leaf"><div class="extracted-file-name">a.mp4</div></div>',
      '</div>',
    ].join('');
    await writeFile(
      join(h.folder, 'index.tgz'),
      buildTarGz([{ name: 'Takeout/archive_browser.html', data: Buffer.from(html) }]),
    );
    h.repo.exports[0].indexFileName = 'index.tgz';
    await h.addPart(
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([{ name: media('a.mp4'), data: randomBytesSeeded(300, 64) }]),
    );
    const run = h.newRun();
    expect(await h.execute(run)).toBe(JobStatus.Success);
    expect(indexOpens).toBe(1);
    expect(h.repo.exports[0].analysis.lastRead.indexMissingFiles).toEqual({ count: 0, sample: [] });
  });

  it('reads nothing on a second run of a catalogued export whose files are all on the server', async () => {
    const h = await harness();
    const content = randomBytesSeeded(500, 8);
    await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz([{ name: media('a.mp4'), data: content }]));
    const first = h.newRun();
    expect(await h.execute(first)).toBe(JobStatus.Success);
    expect(h.repo.assets).toHaveLength(1);

    let opens = 0;
    h.sut.archiveFs = {
      open: (path) => {
        opens++;
        return nodeFileSourceFs.open(path);
      },
    };
    const second = h.newRun();
    expect(await h.execute(second)).toBe(JobStatus.Success);
    expect(opens).toBe(0);
    const stats = h.run(second.id).readStats;
    expect(Object.values(stats.parts).map((p: any) => p.status)).toEqual(['cached']);
    expect(stats.fetchBytesRead).toBe(0);
    expect(h.files(second.id).find((f) => f.takeoutPath === media('a.mp4')).action).toBe(
      TakeoutRunFileAction.ServerDuplicate,
    );
    expect(h.repo.assets).toHaveLength(1);
  });

  it('never reads again when a resumed run has plan rows', async () => {
    const h = await harness();
    const content = randomBytesSeeded(500, 9);
    await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz([{ name: media('a.mp4'), data: content }]));
    const run = h.newRun();
    // quota 0: the run plans, then stops at the first upload
    h.mocks.user.get.mockResolvedValue({ quotaSizeInBytes: 1, quotaUsageInBytes: 0 } as any);
    expect(await h.execute(run)).toBe(JobStatus.Failed);
    expect(h.run(run.id).error).toBe('quota exceeded');
    const row = h.files(run.id).find((f) => f.takeoutPath === media('a.mp4'));
    expect(row.status).toBe(TakeoutRunFileStatus.Planned);

    // quota raised, Resume: reading is skipped, the planned row is imported (F16)
    h.mocks.user.get.mockResolvedValue({ quotaSizeInBytes: null, quotaUsageInBytes: 0 } as any);
    await h.repo.requeueRun(run.id, 1);
    h.repo.statusLog = [];
    expect(await h.execute({ id: run.id, attempt: 1 })).toBe(JobStatus.Success);
    expect(h.repo.statusLog).not.toContain('reading');
    expect(h.repo.statusLog).not.toContain('planning');
    expect(h.repo.assets).toHaveLength(1);
  });

  it('plans with exact file counters although the live ones drifted over a restart', async () => {
    const h = await harness();
    const a = randomBytesSeeded(500, 21);
    const b = randomBytesSeeded(600, 22);
    await h.addPart(
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([
        { name: media('a.mp4'), data: a },
        { name: media('a.mp4.supplemental-metadata.json'), data: Buffer.from('{"title":"a.mp4"}') },
        { name: media('Album/a.mp4'), data: a },
        { name: media('b.mp4'), data: b },
      ]),
    );
    const run = h.newRun();
    // the first attempt reads the part completely, then stops before its plan is committed
    vi.spyOn(h.repo, 'commitPlan').mockRejectedValueOnce(new Error('connection lost'));
    expect(await h.execute(run)).toBe(JobStatus.Failed);
    // what a restart and a cancel leave in the live counters: entries counted twice, blobs seen as duplicates
    const stored = h.run(run.id).readStats;
    const [partId] = Object.keys(stored.parts);
    Object.assign(stored, { filesFound: 7, mediaFound: 5, localDuplicatesSkipped: 3, stagedFiles: 1 });
    Object.assign(stored.parts[partId], { entries: 7, media: 5, duplicates: 3, staged: 1 });

    await h.repo.requeueRun(run.id, 1);
    expect(await h.execute({ id: run.id, attempt: 1 })).toBe(JobStatus.Success);
    const stats = h.run(run.id).readStats;
    expect(stats.parts[partId]).toMatchObject({
      status: 'read',
      passes: 1,
      entries: 4,
      media: 3,
      staged: 2,
      duplicates: 1,
    });
    expect(stats).toMatchObject({
      filesFound: 4,
      mediaFound: 3,
      jsonFound: 1,
      serverDuplicatesSkipped: 0,
      localDuplicatesSkipped: 1,
      stagedFiles: 2,
      stagedBytes: 1100,
      deferredFiles: 0,
    });
    expect(h.repo.assets).toHaveLength(2);
  });

  it('moves the blob to its target before the asset is created, with the same create arguments', async () => {
    const h = await harness();
    const content = randomBytesSeeded(500, 10);
    await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz([{ name: media('a.mp4'), data: content }]));
    const seen: Array<{ exists: boolean; checksum: Buffer; originalFileName: string }> = [];
    const create = h.repo.assetRepository().create;
    h.mocks.asset.create.mockImplementation((async (row: any) => {
      seen.push({
        exists: await exists(row.originalPath),
        checksum: row.checksum,
        originalFileName: row.originalFileName,
      });
      return create(row);
    }) as any);
    const run = h.newRun();
    expect(await h.execute(run)).toBe(JobStatus.Success);
    expect(seen).toEqual([{ exists: true, checksum: sha1(content), originalFileName: 'a.mp4' }]);
  });

  describe('repair (9.1)', () => {
    it('moves an asset-less complete target back to staging, and imports it', async () => {
      const h = await harness();
      const content = randomBytesSeeded(500, 11);
      const { run, target } = await plannedUpload(h, content);
      await writeFile(target, content);
      h.repo.runFiles[0].targetPath = target;
      await h.repo.requeueRun(run.id, 1);
      expect(await h.execute({ id: run.id, attempt: 1 })).toBe(JobStatus.Success);
      expect(await exists(target)).toBe(false);
      expect(h.repo.assets).toHaveLength(1);
      expect(await readFile(h.repo.assets[0].originalPath)).toEqual(content);
      expect(h.run(run.id).readStats.fetchFiles ?? 0).toBe(0);
    });

    it('keeps the file of a written row whose asset exists and continues it as created', async () => {
      const h = await harness();
      const content = randomBytesSeeded(500, 12);
      const { run, target } = await plannedUpload(h, content);
      await writeFile(target, content);
      Object.assign(h.repo.runFiles[0], { targetPath: target, status: TakeoutRunFileStatus.Written });
      h.repo.addAsset({
        id: '00000000-0000-4000-8000-000000000001',
        ownerId: userId,
        checksum: sha1(content),
        originalPath: target,
      });
      await h.repo.requeueRun(run.id, 1);
      expect(await h.execute({ id: run.id, attempt: 1 })).toBe(JobStatus.Success);
      expect(await exists(target)).toBe(true);
      expect(h.repo.runFiles[0].status).toBe(TakeoutRunFileStatus.Done);
      expect(h.repo.assets).toHaveLength(1);
    });

    it('unlinks a target of the wrong size and fetches the content', async () => {
      const h = await harness();
      const content = randomBytesSeeded(500, 13);
      const { run, target } = await plannedUpload(h, content);
      await writeFile(target, content.subarray(0, 100));
      h.repo.runFiles[0].targetPath = target;
      // the catalog of the part, as the first attempt left it
      Object.assign(h.repo.parts[0], {
        catalogStatus: TakeoutCatalogStatus.Complete,
        catalogVersion: CATALOG_VERSION,
        catalogSize: h.repo.parts[0].size,
        catalogMtime: h.repo.parts[0].mtime,
      });
      h.repo.entries.push({
        id: 1,
        exportId: h.exportId,
        partId: h.repo.parts[0].id,
        seq: 0,
        path: media('a.mp4'),
        size: 500,
        kind: 'media',
        checksum: sha1(content),
        endOffset: null,
      });
      await h.repo.requeueRun(run.id, 1);
      expect(await h.execute({ id: run.id, attempt: 1 })).toBe(JobStatus.Success);
      expect(h.run(run.id).readStats.fetchFiles).toBe(1);
      expect(await readFile(h.repo.assets[0].originalPath)).toEqual(content);
    });
  });

  it('orders groups so an alreadyProcessed row finds the asset of a later group (F6)', async () => {
    const h = await harness();
    const content = randomBytesSeeded(500, 14);
    await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz([{ name: media('a.mp4'), data: content }]));
    const run = h.newRun({ status: TakeoutRunStatus.Queued });
    const common = {
      partName: 'takeout-20260914T211500Z-1-001.tgz',
      size: 500,
      checksum: sha1(content),
      fileKind: 'video',
      groupOrder: 0,
      groupKind: 'none',
      isCover: true,
      plan: {},
    };
    await h.repo.insertRunFiles([
      // group 0 depends on the upload of group 1
      {
        ...common,
        runId: run.id,
        seq: 0,
        takeoutPath: media('copy/a.mp4'),
        entrySeq: null,
        action: TakeoutRunFileAction.AlreadyProcessed,
        status: TakeoutRunFileStatus.Planned,
        groupIndex: 0,
        dependsOnSeq: 1,
      },
      {
        ...common,
        runId: run.id,
        seq: 1,
        takeoutPath: media('a.mp4'),
        entrySeq: 0,
        action: TakeoutRunFileAction.Upload,
        status: TakeoutRunFileStatus.Planned,
        groupIndex: 1,
      },
    ]);
    Object.assign(h.repo.parts[0], {
      catalogStatus: TakeoutCatalogStatus.Complete,
      catalogVersion: CATALOG_VERSION,
      catalogSize: h.repo.parts[0].size,
      catalogMtime: h.repo.parts[0].mtime,
    });
    h.repo.entries.push({
      id: 1,
      exportId: h.exportId,
      partId: h.repo.parts[0].id,
      seq: 0,
      path: media('a.mp4'),
      size: 500,
      kind: 'media',
      checksum: sha1(content),
      endOffset: null,
    });
    expect(await h.execute(run)).toBe(JobStatus.Success);
    const [dependent, upload] = h.files(run.id);
    expect(upload.assetId).toBeTruthy();
    expect(dependent.assetId).toBe(upload.assetId);
    expect(dependent.status).toBe(TakeoutRunFileStatus.Done);
  });

  it('leaves no file under upload/ when an upload fails before its asset exists (F18)', async () => {
    const h = await harness();
    const content = randomBytesSeeded(500, 15);
    await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz([{ name: media('a.mp4'), data: content }]));
    h.mocks.asset.create.mockRejectedValue(new Error('database is down'));
    h.mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(undefined as any);
    const run = h.newRun();
    expect(await h.execute(run)).toBe(JobStatus.Success);
    const row = h.files(run.id).find((f) => f.takeoutPath === media('a.mp4'));
    expect(row.status).toBe(TakeoutRunFileStatus.Error);
    expect(row.targetPath).toBeNull();
    const uploadDir = join(h.dir, 'upload', userId);
    const listed = await readdir(uploadDir, { recursive: true });
    const leftovers = listed.filter((name) => name.endsWith('.mp4'));
    expect(leftovers).toEqual([]);
  });

  it('counts only the errors of this attempt for stopAfterErrors (F17)', async () => {
    const h = await harness({ settings: { stopAfterErrors: 1 } });
    const contents = [randomBytesSeeded(300, 16), randomBytesSeeded(300, 17)];
    await h.addPart(
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([
        { name: media('a.mp4'), data: contents[0] },
        { name: media('b.mp4'), data: contents[1] },
      ]),
    );
    const create = h.repo.assetRepository().create;
    let failOnce = true;
    h.mocks.asset.create.mockImplementation(((row: any) => {
      if (failOnce) {
        failOnce = false;
        return Promise.reject(new Error('boom'));
      }
      return create(row);
    }) as any);
    h.mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(undefined as any);
    const run = h.newRun();
    expect(await h.execute(run)).toBe(JobStatus.Failed);
    expect(h.run(run.id).error).toBe('stopped after reaching the error limit');

    await h.repo.requeueRun(run.id, 1);
    expect(await h.execute({ id: run.id, attempt: 1 })).toBe(JobStatus.Success);
    expect(h.repo.assets).toHaveLength(1);
  });

  it('does not upload an album copy that the year copy on the server beats, although the year copy is in the Takeout too', async () => {
    // family 2026-09-29: Google exported album copies of motion photos without their motion clip. The year copy,
    // already on the server, is an exact duplicate of a file of this Takeout; the smaller album copy must still
    // match it by name and time (Go's ShouldUpload: BetterOnServer) and not be uploaded a second time.
    const h = await harness({ settings: { syncAlbums: true } });
    const full = randomBytesSeeded(900, 80);
    const stripped = randomBytesSeeded(600, 81);
    const taken = new Date('2025-04-30T21:17:48.000Z');
    const json = Buffer.from(
      JSON.stringify({ title: 'PXL_1.MP.mp4', photoTakenTime: { timestamp: String(taken.getTime() / 1000) } }),
    );
    await h.addPart(
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([
        { name: media('Photos from 2025/PXL_1.MP.mp4'), data: full },
        { name: media('Photos from 2025/PXL_1.MP.mp4.supplemental-metadata.json'), data: json },
        { name: media('Cruise/metadata.json'), data: Buffer.from('{"title":"Cruise"}') },
        { name: media('Cruise/PXL_1.MP.mp4'), data: stripped },
        { name: media('Cruise/PXL_1.MP.mp4.supplemental-metadata.json'), data: json },
      ]),
    );
    const server = h.repo.addAsset({
      ownerId: userId,
      checksum: sha1(full),
      originalPath: '/upload/PXL_1.MP.mp4',
      originalFileName: 'PXL_1.MP.mp4',
      fileSizeInByte: full.length,
      capturedAt: taken,
      type: AssetType.Video,
    });
    h.mocks.album.getAll.mockResolvedValue([]);
    h.mocks.album.create.mockResolvedValue({ id: 'album-cruise' } as any);
    const run = h.newRun();
    expect(await h.execute(run)).toBe(JobStatus.Success);
    const rows = h.files(run.id);
    expect(rows.find((f) => f.takeoutPath === media('Photos from 2025/PXL_1.MP.mp4'))).toMatchObject({
      action: TakeoutRunFileAction.ServerDuplicate,
      assetId: server.id,
    });
    expect(rows.find((f) => f.takeoutPath === media('Cruise/PXL_1.MP.mp4'))).toMatchObject({
      action: TakeoutRunFileAction.BetterOnServer,
      assetId: server.id,
    });
    expect(h.repo.assets).toHaveLength(1);
    // the album gets the better server asset
    expect(h.mocks.album.addAssetIds).toHaveBeenCalledWith('album-cruise', [server.id]);
  });

  it('turns a planned upload imported meanwhile by another client into a server duplicate', async () => {
    const h = await harness();
    const content = randomBytesSeeded(500, 18);
    const other = randomBytesSeeded(700, 65);
    await h.addPart(
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([
        { name: media('a.mp4'), data: content },
        { name: media('b.mp4'), data: other },
      ]),
    );
    const run = h.newRun();
    const original = h.repo.commitPlan.bind(h.repo);
    vi.spyOn(h.repo, 'commitPlan').mockImplementation(async (input) => {
      const ok = await original(input);
      h.repo.addAsset({ ownerId: userId, checksum: sha1(content), originalPath: '/elsewhere/a.mp4' });
      return ok;
    });
    expect(await h.execute(run)).toBe(JobStatus.Success);
    const row = h.files(run.id).find((f) => f.takeoutPath === media('a.mp4'));
    expect(row.action).toBe(TakeoutRunFileAction.ServerDuplicate);
    expect(h.repo.assets).toHaveLength(2);
    // the planned bytes of the file that became a duplicate leave the total: the bar ends at 100%
    expect(h.run(run.id)).toMatchObject({ bytesTotal: 700, bytesDone: 700 });
  });

  describe('a file the user permanently deleted before is handled like an upload of it', () => {
    it('skip: not imported, reported as previouslyDeletedSkipped, the owner told', async () => {
      const { h, run, row, asset, checksum } = await importWithDeleted(DeletedReimportMode.Skip);

      expect(asset).toBeUndefined();
      expect(h.repo.assets).toHaveLength(1);
      expect(row).toMatchObject({
        action: TakeoutRunFileAction.PreviouslyDeletedSkipped,
        status: TakeoutRunFileStatus.Skipped,
        reason: 'previously deleted (skipped)',
        targetPath: null,
      });
      // no file of it is left under upload/, only the other one
      const uploaded = await readdir(join(h.dir, 'upload', userId), { recursive: true, withFileTypes: true });
      expect(uploaded.filter((entry) => entry.isFile())).toHaveLength(1);
      expect(h.mocks.assetDeletedChecksum.markReimported).toHaveBeenCalledExactlyOnceWith(
        userId,
        checksum,
        DeletedReimportMode.Skip,
      );
      expect(reimports(h)).toEqual([{ userId }]);
      expect(run.counters.discarded.previouslyDeleted).toBe(1);
      expect(run.counters.result.uploaded).toBe(1);
      // the file left the plan while it was imported: the bar still ends at 100%
      expect(run).toMatchObject({ bytesTotal: 700, bytesDone: 700 });
    });

    it('trash: imported and moved to the trash right away', async () => {
      const { h, run, row, asset, checksum } = await importWithDeleted(DeletedReimportMode.Trash);

      expect(h.repo.assets).toHaveLength(2);
      expect(row).toMatchObject({ action: TakeoutRunFileAction.Upload, status: TakeoutRunFileStatus.Done });
      expect(row.assetId).toBe(asset!.id);
      expect(row.fallbacks).toContain('previouslyDeleted:trash');
      expect(h.mocks.asset.updateAll).toHaveBeenCalledExactlyOnceWith([asset!.id], {
        deletedAt: expect.any(Date),
        status: AssetStatus.Trashed,
      });
      expect(h.mocks.album.addAssetIds).not.toHaveBeenCalled();
      expect(h.mocks.assetDeletedChecksum.markReimported).toHaveBeenCalledExactlyOnceWith(
        userId,
        checksum,
        DeletedReimportMode.Trash,
      );
      expect(reimports(h)).toEqual([{ userId }]);
      expect(run.counters.discarded.previouslyDeleted).toBe(0);
      expect(run.counters.result.uploaded).toBe(2);
    });

    it('album: imported and added to the "Previously deleted" album', async () => {
      const { h, run, row, asset, checksum } = await importWithDeleted(DeletedReimportMode.Album);

      expect(h.repo.assets).toHaveLength(2);
      expect(row.fallbacks).toContain('previouslyDeleted:album');
      expect(h.mocks.album.create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ albumName: 'Previously deleted' }),
        [],
        [{ userId, role: AlbumUserRole.Owner }],
        userId,
      );
      expect(h.mocks.album.addAssetIds).toHaveBeenCalledExactlyOnceWith('album-prev', [asset!.id]);
      expect(h.mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(h.mocks.assetDeletedChecksum.markReimported).toHaveBeenCalledExactlyOnceWith(
        userId,
        checksum,
        DeletedReimportMode.Album,
      );
      expect(reimports(h)).toEqual([{ userId }]);
      expect(run.counters.result.uploaded).toBe(2);
    });
  });

  it('fails fetching with the exact missing byte count and keeps the plan for Resume', async () => {
    const size = 3 * KiB;
    const server = randomBytesSeeded(size, 19);
    const content = Buffer.concat([server.subarray(0, 512), randomBytesSeeded(size - 512, 20)]);
    const h = await harness();
    await writeFile(join(h.dir, 'server.mp4'), server);
    h.repo.addAsset({
      ownerId: userId,
      checksum: sha1(server),
      originalPath: join(h.dir, 'server.mp4'),
      fileSizeInByte: size,
    });
    await h.addPart(
      'takeout-20260914T211500Z-1-001.zip',
      buildZip([{ nameBytes: Buffer.from(media('big.mp4')), data: content, method: 0 }]),
    );
    h.sut.readLimits = { ...h.sut.readLimits, freeSpaceReserve: 1000 };
    h.sut.diskAvailable = () => Promise.resolve(1000 + size - 100);
    const run = h.newRun();
    expect(await h.execute(run)).toBe(JobStatus.Failed);
    expect(h.run(run.id).error).toBe('Not enough free space: 100 B more needed');
    expect(h.files(run.id).length).toBeGreaterThan(0);
  });

  it('fails the run, not the rows, when a part needed for fetching is missing', async () => {
    const h = await harness();
    const content = randomBytesSeeded(500, 21);
    const part = await h.addPart(
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([{ name: media('a.mp4'), data: content }]),
    );
    const run = h.newRun();
    await h.repo.insertRunFiles([
      {
        runId: run.id,
        seq: 0,
        takeoutPath: media('a.mp4'),
        partName: part.fileName,
        entrySeq: null,
        size: 500,
        checksum: sha1(content),
        fileKind: 'video',
        action: TakeoutRunFileAction.Upload,
        status: TakeoutRunFileStatus.Planned,
        groupIndex: 0,
        groupOrder: 0,
        isCover: true,
        plan: {},
      },
    ]);
    await rm(join(h.folder, part.fileName));
    expect(await h.execute(run)).toBe(JobStatus.Failed);
    expect(h.run(run.id).error).toMatch(/is missing: put it back and Resume/);
    expect(h.files(run.id)[0].status).toBe(TakeoutRunFileStatus.Planned);
  });

  it('fetches legacy rows by path and size, one request per checksum, stopping the tgz walk when all are found', async () => {
    const h = await harness();
    const a = randomBytesSeeded(500, 22);
    const tail = randomBytesSeeded(400 * KiB, 23);
    const gz = buildTarGz([
      { name: media('a.mp4'), data: a },
      { name: media('tail.bin'), data: tail },
    ]);
    const part = await h.addPart('takeout-20260914T211500Z-1-001.tgz', gz);
    const run = h.newRun();
    // rows planned by the old code: no entry position, no catalog
    await h.repo.insertRunFiles([
      {
        runId: run.id,
        seq: 0,
        takeoutPath: media('a.mp4'),
        partName: part.fileName,
        entrySeq: null,
        size: 500,
        checksum: sha1(a),
        fileKind: 'video',
        action: TakeoutRunFileAction.Upload,
        status: TakeoutRunFileStatus.Planned,
        groupIndex: 0,
        groupOrder: 0,
        isCover: true,
        plan: {},
      },
    ]);
    expect(await h.execute(run)).toBe(JobStatus.Success);
    expect(h.repo.assets).toHaveLength(1);
    const stats = h.run(run.id).readStats;
    expect(stats.fetchFiles).toBe(1);
    expect(stats.fetchBytesRead).toBeLessThan(gz.length);
  });

  it('writes report rows for unreadable parts, bad zip entries and index paths found nowhere', async () => {
    const h = await harness();
    const good = randomBytesSeeded(300, 24);
    await h.addPart(
      'takeout-20260914T211500Z-1-001.zip',
      buildZip([
        { nameBytes: Buffer.from(media('good.mp4')), data: good, method: 0 },
        { nameBytes: Buffer.from(media('bad.mp4')), data: randomBytesSeeded(300, 25), method: 0, crcOverride: 7 },
      ]),
      1,
    );
    const flipped = gzipSync(buildTar([{ name: media('photo.mp4'), data: randomBytesSeeded(3 * 1024 * KiB, 26) }]), {
      level: 0,
    });
    flipped[10 + 5 + 4000] ^= 0x01;
    await h.addPart('takeout-20260914T211500Z-1-002.tgz', flipped, 2);
    const cut = buildTarGz([
      { name: media('one.mp4'), data: randomBytesSeeded(600, 27) },
      { name: media('two.bin'), data: randomBytesSeeded(300 * KiB, 28) },
    ]);
    await h.addPart('takeout-20260914T211500Z-1-003.tgz', cut.subarray(0, Math.floor(cut.length / 2)), 3);
    await h.repo.updateExport(h.exportId, {
      analysis: { indexFiles: [media('good.mp4'), media('never-exported.mp4')] },
    });

    const run = h.newRun({ importAnyway: true });
    expect(await h.execute(run)).toBe(JobStatus.Success);
    const rows = h.files(run.id);
    const unreadable = rows.filter((r) => r.action === TakeoutRunFileAction.PartUnreadable);
    expect(unreadable.map((r) => r.reason)).toEqual(
      expect.arrayContaining([
        'CRC-32 mismatch',
        'the part is corrupt (gzip CRC mismatch); none of its files was imported; download this part again',
        expect.stringMatching(/later files of this part could not be read$/),
      ]),
    );
    const missing = rows.filter((r) => r.action === TakeoutRunFileAction.MissingFromArchive);
    expect(missing.map((r) => r.takeoutPath)).toEqual([media('never-exported.mp4')]);
    const counters = h.run(run.id).counters;
    expect(counters.discarded.unreadable).toBe(unreadable.length);
    expect(counters.discarded.missingFromArchive).toBe(1);
    const analysis = h.repo.exports[0].analysis;
    expect(analysis.lastRead.unreadableParts.map((p: any) => p.fileName)).toEqual([
      'takeout-20260914T211500Z-1-002.tgz',
      'takeout-20260914T211500Z-1-003.tgz',
    ]);
    expect(h.repo.exports[0].completeness).toBe('incomplete');
  });

  it('marks a part missing at reading start, deletes its entries and plans without it', async () => {
    const h = await harness();
    await h.addPart(
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([{ name: media('a.mp4'), data: randomBytesSeeded(100, 29) }]),
      1,
    );
    const gone = await h.addPart(
      'takeout-20260914T211500Z-1-002.tgz',
      buildTarGz([{ name: media('b.mp4'), data: randomBytesSeeded(100, 30) }]),
      2,
    );
    Object.assign(h.repo.parts[1], {
      catalogStatus: TakeoutCatalogStatus.Complete,
      catalogVersion: CATALOG_VERSION,
      catalogSize: gone.size,
      catalogMtime: gone.mtime,
    });
    h.repo.entries.push({
      id: 99,
      exportId: h.exportId,
      partId: gone.id,
      seq: 0,
      path: media('b.mp4'),
      size: 100,
      kind: 'media',
      checksum: sha1(Buffer.from('b')),
    });
    await rm(join(h.folder, gone.fileName));
    const run = h.newRun({ importAnyway: true });
    expect(await h.execute(run)).toBe(JobStatus.Success);
    expect(h.repo.parts[1].isMissing).toBe(true);
    expect(h.repo.entries.some((e) => e.partId === gone.id)).toBe(false);
    const rows = h.files(run.id);
    expect(rows.some((r) => r.takeoutPath === media('b.mp4'))).toBe(false);
    expect(rows.find((r) => r.takeoutPath === gone.fileName)?.reason).toBe('archive file missing');
  });

  describe('cancel, failure and Discard (10.1, 10.2, 5.3)', () => {
    it('keeps staging and reclaims targets when a run is cancelled; created assets stay and get their jobs', async () => {
      const h = await harness();
      const content = randomBytesSeeded(500, 31);
      await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz([{ name: media('a.mp4'), data: content }]));
      const run = h.newRun();
      // cancel as soon as planning committed
      const original = h.repo.commitPlan.bind(h.repo);
      vi.spyOn(h.repo, 'commitPlan').mockImplementation(async (input) => {
        const ok = await original(input);
        await h.repo.requestCancel(run.id);
        h.sut.onCancel({ runId: run.id });
        return ok;
      });
      expect(await h.execute(run)).toBe(JobStatus.Skipped);
      expect(h.run(run.id).status).toBe(TakeoutRunStatus.Cancelled);
      expect(h.run(run.id).hasStaging).toBe(true);
      expect(h.run(run.id).leaseToken).toBeNull();
      expect(h.files(run.id).find((f) => f.takeoutPath === media('a.mp4'))).toMatchObject({
        status: TakeoutRunFileStatus.Skipped,
        fallbacks: ['cancelled'],
      });
      const blob = join(runStagingDir(h.folder, run.id), hex(sha1(content)).slice(0, 2), hex(sha1(content)));
      expect(await exists(blob)).toBe(true);
      expect(h.run(run.id).readStats.stagingBytes).toBe(500);

      // Discard: the staging goes
      await discardRunStaging(lifecycleOf(h), run.id);
      expect(h.run(run.id).hasStaging).toBe(false);
      for (let i = 0; i < 50 && (await exists(runStagingDir(h.folder, run.id))); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await exists(runStagingDir(h.folder, run.id))).toBe(false);
    });

    it('lets no cleanup outside the job touch a run the job holds; the job finalizes its files (I10)', async () => {
      const h = await harness();
      const content = randomBytesSeeded(500, 70);
      const { run, target } = await plannedUpload(h, content);
      await writeFile(target, content);
      h.repo.runFiles[0].targetPath = target;
      await h.repo.requeueRun(run.id, 1);
      // a Cancel arrives while the resumed run is still queued and its job repairs and re-checks, lease held
      const results: boolean[] = [];
      const recheck = h.repo.getUploadAssetsByChecksums.bind(h.repo);
      vi.spyOn(h.repo, 'getUploadAssetsByChecksums').mockImplementation(async (id, checksums) => {
        if (results.length === 0) {
          expect(h.run(run.id).status).toBe(TakeoutRunStatus.Queued);
          results.push(
            await cleanupCancelledRun(lifecycleOf(h), run.id, { token: null, from: [TakeoutRunStatus.Queued] }),
          );
        }
        return recheck(id, checksums);
      });
      expect(await h.execute({ id: run.id, attempt: 1 })).toBe(JobStatus.Success);
      expect(results).toEqual([false]);
      expect(h.run(run.id).status).toBe(TakeoutRunStatus.Completed);
      expect(h.repo.assets).toHaveLength(1);
      expect(await readFile(h.repo.assets[0].originalPath)).toEqual(content);
    });

    it('keeps a target the cancel could not reclaim on an open row, for the boot step or Discard (I4)', async () => {
      const h = await harness();
      const content = randomBytesSeeded(500, 71);
      const { run, target } = await plannedUpload(h, content);
      await writeFile(target, content);
      Object.assign(h.repo.runFiles[0], { targetPath: target, status: TakeoutRunFileStatus.Written });
      Object.assign(h.repo.runs[0], { status: TakeoutRunStatus.Queued, hasStaging: true });
      // the staging share does not answer: the store cannot be opened
      const down: StagingFs = { ...nodeStagingFs, mkdir: (() => Promise.reject(errno('EIO'))) as any };
      const lifecycle = { ...lifecycleOf(h), stagingFs: down };
      expect(await cleanupCancelledRun(lifecycle, run.id, { token: null, from: [TakeoutRunStatus.Queued] })).toBe(true);
      expect(h.run(run.id).status).toBe(TakeoutRunStatus.Cancelled);
      expect(h.repo.runFiles[0]).toMatchObject({ status: TakeoutRunFileStatus.Written, targetPath: target });
      expect(await exists(target)).toBe(true);
      const stopped = await h.repo.getStoppedRunsWithTargets();
      expect(stopped.map((r) => r.id)).toEqual([run.id]);

      // Discard removes it
      await discardRunStaging(lifecycleOf(h), run.id);
      expect(await exists(target)).toBe(false);
      expect(h.repo.runFiles[0]).toMatchObject({ status: TakeoutRunFileStatus.Skipped, targetPath: null });
    });

    it('ends a run that is cancelled while it finishes as completed, and releases the lease', async () => {
      const h = await harness();
      await h.addPart(
        'takeout-20260914T211500Z-1-001.tgz',
        buildTarGz([{ name: media('a.mp4'), data: randomBytesSeeded(500, 72) }]),
      );
      const run = h.newRun();
      const cas = h.repo.setRunStatusCas.bind(h.repo);
      vi.spyOn(h.repo, 'setRunStatusCas').mockImplementation(async (id, token, status, patch) => {
        const ok = await cas(id, token, status, patch);
        if (status === TakeoutRunStatus.Finishing) {
          await h.repo.requestCancel(id);
          h.sut.onCancel({ runId: id });
        }
        return ok;
      });
      expect(await h.execute(run)).toBe(JobStatus.Success);
      expect(h.run(run.id)).toMatchObject({ status: TakeoutRunStatus.Completed, leaseToken: null });
    });

    it('ends a run that is cancelled while it fails as cancelled, never left cancelling', async () => {
      const h = await harness();
      await h.addPart(
        'takeout-20260914T211500Z-1-001.tgz',
        buildTarGz([{ name: media('a.mp4'), data: randomBytesSeeded(500, 73) }]),
      );
      h.mocks.user.get.mockResolvedValue({ quotaSizeInBytes: 1, quotaUsageInBytes: 0 } as any);
      const run = h.newRun();
      const finish = h.repo.finishRunCas.bind(h.repo);
      vi.spyOn(h.repo, 'finishRunCas').mockImplementation(async (id, from, token, status, patch) => {
        if (status === TakeoutRunStatus.Failed) {
          await h.repo.requestCancel(id);
        }
        return finish(id, from, token, status, patch);
      });
      expect(await h.execute(run)).toBe(JobStatus.Failed);
      expect(h.run(run.id)).toMatchObject({ status: TakeoutRunStatus.Cancelled, leaseToken: null, hasStaging: true });
    });

    it('cleans up a queued run from the API path', async () => {
      const h = await harness();
      const run = h.newRun({ status: TakeoutRunStatus.Queued });
      expect(await cleanupCancelledRun(lifecycleOf(h), run.id, { token: null, from: [TakeoutRunStatus.Queued] })).toBe(
        true,
      );
      expect(h.run(run.id).status).toBe(TakeoutRunStatus.Cancelled);
      expect(h.mocks.job.removeJob).toHaveBeenCalled();
    });

    it('stops showing the parts of a cancelled run as being read, and keeps the bytes they read', async () => {
      const h = await harness();
      const part = await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz([]));
      const run = h.newRun({
        status: TakeoutRunStatus.Cancelling,
        readStats: {
          parts: {
            [part.id]: {
              partId: part.id,
              fileName: part.fileName,
              size: 900,
              status: 'reading',
              passes: 1,
              bytesRead: 700,
            },
          },
        },
      });
      expect(
        await cleanupCancelledRun(lifecycleOf(h), run.id, { token: null, from: [TakeoutRunStatus.Cancelling] }),
      ).toBe(true);
      const ps = h.run(run.id).readStats.parts[part.id];
      expect(ps).toMatchObject({ status: 'pending', bytesRead: 700 });
      expect(ps.finishedAt).not.toBeNull();
      expect(h.repo.parts[0].bytesRead).toBe(700);
    });

    it('keeps the staging of a failed run with its size and expiry', async () => {
      const h = await harness();
      const content = randomBytesSeeded(500, 32);
      await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz([{ name: media('a.mp4'), data: content }]));
      h.mocks.user.get.mockResolvedValue({ quotaSizeInBytes: 1, quotaUsageInBytes: 0 } as any);
      const run = h.newRun();
      expect(await h.execute(run)).toBe(JobStatus.Failed);
      const stored = h.run(run.id);
      expect(stored.hasStaging).toBe(true);
      expect(stored.readStats.stagingBytes).toBe(500);
      expect(Date.parse(stored.readStats.stagingExpiresAt)).toBeGreaterThan(Date.now() + 6 * 24 * 3_600_000);
      expect(await exists(runStagingDir(h.folder, run.id))).toBe(true);
    });

    it('lets a new run adopt the staging of a cancelled one without reading the parts again', async () => {
      const h = await harness();
      const content = randomBytesSeeded(500, 33);
      await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz([{ name: media('a.mp4'), data: content }]));
      h.mocks.user.get.mockResolvedValue({ quotaSizeInBytes: 1, quotaUsageInBytes: 0 } as any);
      const first = h.newRun();
      expect(await h.execute(first)).toBe(JobStatus.Failed);
      h.mocks.user.get.mockResolvedValue({ quotaSizeInBytes: null, quotaUsageInBytes: 0 } as any);

      const { run: second, adopted } = await h.repo.createRunWithAdoption(
        { userId, exportId: h.exportId, settings: h.settings },
        first.id,
      );
      expect(adopted).toBe(true);
      let opens = 0;
      h.sut.archiveFs = {
        open: (path) => {
          opens++;
          return nodeFileSourceFs.open(path);
        },
      };
      expect(await h.execute(second)).toBe(JobStatus.Success);
      expect(opens).toBe(0);
      expect(h.run(first.id).supersededBy).toBe(second.id);
      expect(h.repo.assets).toHaveLength(1);
      expect(await exists(runStagingDir(h.folder, first.id))).toBe(false);
    });
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) {
      throw new Error('condition not met in time');
    }
    await sleep(5);
  }
}

/** An archive file system that counts opens, reads and bytes, with a hook after every read */
function countingFs() {
  const counts = { opens: 0, reads: 0, bytes: 0 };
  const hooks: {
    afterRead: ((position: number, bytes: number) => void) | null;
    beforeRead: (() => Promise<void> | void) | null;
  } = {
    afterRead: null,
    beforeRead: null,
  };
  const fs: FileSourceFs = {
    open: async (path) => {
      const real = await nodeFileSourceFs.open(path);
      counts.opens++;
      return {
        read: async (buffer, offset, length, position) => {
          await hooks.beforeRead?.();
          const result = await real.read(buffer, offset, length, position);
          counts.reads++;
          counts.bytes += result.bytesRead;
          hooks.afterRead?.(position, result.bytesRead);
          return result;
        },
        stat: () => real.stat(),
        close: () => real.close(),
      };
    },
  };
  return { fs, counts, hooks };
}

/** What the pause and resume endpoints do for a run whose job is alive: the check-and-set, then the event */
const pauseRun = async (h: RunHarness, runId: string) => {
  expect(await h.repo.requestPause(runId, new Date())).toBe(true);
  await h.sut.onPauseChange({ runId });
};
const resumeRun = async (h: RunHarness, runId: string) => {
  expect(await h.repo.resumePausedRun(runId)).toBe(true);
  await h.sut.onPauseChange({ runId });
};

const smallFiles = (count: number, seed: number) =>
  Array.from({ length: count }, (_, i) => ({ name: media(`p${i}.mp4`), data: randomBytesSeeded(900, seed + i) }));

/** A run that is paused at its 10th read, on a worker whose only Takeout queue place it holds */
const parkedHarness = async (seed: number) => {
  const { fs, counts, hooks } = countingFs();
  const h = await harness({ fs, limits: { readChunk: 1 * KiB, readaheadDepth: 1 } });
  h.sut.progressMs = 20;
  h.sut.parkAfterMs = 100;
  // one place: the paused run holds all of them
  h.sut.queueConcurrency = 1;
  h.mocks.job.getJobCounts.mockResolvedValue({ waiting: 0 } as any);
  await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz(smallFiles(20, seed)));
  const run = h.newRun();
  hooks.afterRead = () => {
    if (counts.reads === 10) {
      void pauseRun(h, run.id);
    }
  };
  return { h, run };
};

/** The API service of a new process over the same repository */
const bootedApi = (h: RunHarness) => {
  const api = newTestService(TakeoutService, { takeout: h.repo as any });
  StorageCore.setMediaLocation(h.dir);
  api.mocks.job.queue.mockResolvedValue();
  api.mocks.job.removeJob.mockResolvedValue();
  api.mocks.storage.checkDiskUsage.mockResolvedValue({ available: 1e13, free: 1e13, total: 1e13 });
  return api;
};

describe('TakeoutRunService pause and resume', () => {
  it('pauses a read at its next read, keeps its lease, and resumes the same read: each byte read once', async () => {
    const { fs, counts, hooks } = countingFs();
    const h = await harness({ fs, limits: { readChunk: 1 * KiB, readaheadDepth: 1 } });
    h.sut.progressMs = 30;
    const tgz = buildTarGz(smallFiles(20, 500));
    await h.addPart('takeout-20260914T211500Z-1-001.tgz', tgz);
    const run = h.newRun();
    hooks.afterRead = () => {
      if (counts.reads === 10) {
        void pauseRun(h, run.id);
      }
    };
    const done = h.execute(run);
    await until(() => h.run(run.id).status === TakeoutRunStatus.Paused);
    await sleep(100);
    const readsAtPause = counts.reads;
    await sleep(200);
    expect(counts.reads).toBe(readsAtPause);
    expect(counts.bytes).toBeLessThan(tgz.length);

    const paused = h.run(run.id);
    // the job keeps its lease and heartbeat; the progress writes keep the pause the API wrote
    expect(paused.leaseToken).not.toBeNull();
    expect(paused.readStats).toMatchObject({ pausedFrom: TakeoutRunStatus.Reading });
    expect(mapRun(paused)).toMatchObject({
      status: TakeoutRunStatus.Paused,
      pausedFrom: TakeoutRunStatus.Reading,
      pausedAt: expect.any(String),
    });
    expect(Object.values(paused.readStats.parts).map((ps: any) => ps.status)).toEqual(['paused']);
    expect(paused.readStats.etaSeconds).toBeNull();

    await resumeRun(h, run.id);
    expect(await done).toBe(JobStatus.Success);
    const stored = h.run(run.id);
    expect(stored.status).toBe(TakeoutRunStatus.Completed);
    expect(unique(h.repo.statusLog)).toEqual([
      'reading',
      'paused',
      'reading',
      'planning',
      'importing',
      'finishing',
      'completed',
    ]);
    const [ps] = Object.values(stored.readStats.parts) as any[];
    expect(ps).toMatchObject({ status: 'read', passes: 1, bytesRead: tgz.length });
    expect(counts).toMatchObject({ opens: 1, bytes: tgz.length });
    expect(stored.readStats.pausedMs).toBeGreaterThanOrEqual(300);
    expect(ps.pausedMs).toBeGreaterThanOrEqual(300);
    expect(stored.readStats.pausedAt).toBeUndefined();
    expect(mapRun(stored)).toMatchObject({ pausedAt: null, pausedFrom: null });
    expect(h.repo.assets).toHaveLength(20);
  });

  it('pauses between groups while importing and continues with the next group', async () => {
    const h = await harness();
    h.sut.progressMs = 30;
    await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz(smallFiles(3, 520)));
    const run = h.newRun();
    const create = h.mocks.asset.create.getMockImplementation()!;
    let pausedOnce = false;
    h.mocks.asset.create.mockImplementation(async (asset: any) => {
      const created = await create(asset);
      if (!pausedOnce) {
        pausedOnce = true;
        await pauseRun(h, run.id);
      }
      return created;
    });
    const done = h.execute(run);
    await until(() => h.run(run.id).status === TakeoutRunStatus.Paused);
    await sleep(200);
    // the group in progress finished: one asset, and no file under upload/ without its asset (I4)
    expect(h.repo.assets).toHaveLength(1);
    expect(h.run(run.id).readStats.pausedFrom).toBe(TakeoutRunStatus.Importing);
    expect(h.files(run.id).filter((f) => f.targetPath && f.status === TakeoutRunFileStatus.Written)).toEqual([]);

    await resumeRun(h, run.id);
    expect(await done).toBe(JobStatus.Success);
    expect(h.repo.assets).toHaveLength(3);
    expect(h.run(run.id).status).toBe(TakeoutRunStatus.Completed);
  });

  it('pauses in finishing and sees the resume without its event (the progress tick is stopped there)', async () => {
    const h = await harness();
    h.sut.progressMs = 30;
    await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz(smallFiles(2, 530)));
    const run = h.newRun();
    const cas = h.repo.setRunStatusCas.bind(h.repo);
    vi.spyOn(h.repo, 'setRunStatusCas').mockImplementation(async (id, token, status, patch) => {
      const ok = await cas(id, token, status, patch);
      if (status === TakeoutRunStatus.Finishing) {
        await pauseRun(h, id);
      }
      return ok;
    });
    const done = h.execute(run);
    await until(() => h.run(run.id).status === TakeoutRunStatus.Paused);
    await sleep(100);
    expect(h.run(run.id)).toMatchObject({ status: TakeoutRunStatus.Paused, hasStaging: true });
    expect(h.run(run.id).readStats.pausedFrom).toBe(TakeoutRunStatus.Finishing);
    // resumed, and the event never reaches this worker
    expect(await h.repo.resumePausedRun(run.id)).toBe(true);
    expect(await done).toBe(JobStatus.Success);
    expect(h.run(run.id)).toMatchObject({ status: TakeoutRunStatus.Completed, leaseToken: null, hasStaging: false });
  });

  it.each([
    ['with its event', true],
    ['seen by the pause poll', false],
  ])('completes a run cancelled while it is paused in finishing, %s: every file is imported', async (_name, event) => {
    const h = await harness();
    h.sut.progressMs = 30;
    await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz(smallFiles(2, 535)));
    const run = h.newRun();
    const cas = h.repo.setRunStatusCas.bind(h.repo);
    vi.spyOn(h.repo, 'setRunStatusCas').mockImplementation(async (id, token, status, patch) => {
      const ok = await cas(id, token, status, patch);
      if (status === TakeoutRunStatus.Finishing) {
        await pauseRun(h, id);
      }
      return ok;
    });
    const done = h.execute(run);
    await until(() => h.run(run.id).status === TakeoutRunStatus.Paused);
    await sleep(100);
    expect(await h.repo.requestCancel(run.id)).toBe(true);
    if (event) {
      h.sut.onCancel({ runId: run.id });
    }
    expect(await done).toBe(JobStatus.Success);
    expect(h.run(run.id)).toMatchObject({ status: TakeoutRunStatus.Completed, leaseToken: null, hasStaging: false });
    expect(h.repo.assets).toHaveLength(2);
    expect(h.mocks.notification.create).toHaveBeenCalled();
    expect(await exists(runStagingDir(h.folder, run.id))).toBe(false);
  });

  it('waits at a pause point with one wait for the whole pause, not one per poll', async () => {
    const h = await harness();
    h.sut.progressMs = 5;
    await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz(smallFiles(3, 545)));
    const run = h.newRun();
    const create = h.mocks.asset.create.getMockImplementation()!;
    let pausedOnce = false;
    h.mocks.asset.create.mockImplementation(async (asset: any) => {
      const created = await create(asset);
      if (!pausedOnce) {
        pausedOnce = true;
        await pauseRun(h, run.id);
      }
      return created;
    });
    const done = h.execute(run);
    await until(() => h.run(run.id).status === TakeoutRunStatus.Paused);
    const signal: AbortSignal = (h.sut as any).attempts.get(run.id).signal;
    await sleep(50);
    const early = getEventListeners(signal, 'abort').length;
    // dozens of polls later
    await sleep(300);
    expect(getEventListeners(signal, 'abort').length).toBe(early);
    await resumeRun(h, run.id);
    expect(await done).toBe(JobStatus.Success);
    expect(h.repo.assets).toHaveLength(3);
  });

  it('cancels a paused run: the job stops waiting, cleans up and keeps the staging', async () => {
    const { fs, counts, hooks } = countingFs();
    const h = await harness({ fs, limits: { readChunk: 1 * KiB, readaheadDepth: 1 } });
    h.sut.progressMs = 30;
    await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz(smallFiles(20, 540)));
    const run = h.newRun();
    hooks.afterRead = () => {
      if (counts.reads === 10) {
        void pauseRun(h, run.id);
      }
    };
    const done = h.execute(run);
    await until(() => h.run(run.id).status === TakeoutRunStatus.Paused);
    await sleep(50);

    expect(await h.repo.requestCancel(run.id)).toBe(true);
    h.sut.onCancel({ runId: run.id });
    expect(await done).toBe(JobStatus.Skipped);
    const stored = h.run(run.id);
    expect(stored).toMatchObject({ status: TakeoutRunStatus.Cancelled, leaseToken: null, hasStaging: true });
    expect(stored.readStats.pausedAt).toBeUndefined();
    expect(Object.values(stored.readStats.parts).map((ps: any) => ps.status)).toEqual(['pending']);
    expect(h.repo.parts[0].catalogStatus).toBe(TakeoutCatalogStatus.Partial);
    expect(await exists(runStagingDir(h.folder, run.id))).toBe(true);
  });

  it('never fails a paused run as stalled, not even with a read that hung across the pause', async () => {
    const { fs, hooks } = countingFs();
    const h = await harness({ fs, limits: { readStallMs: 100 } });
    h.sut.progressMs = 20;
    await h.addPart('takeout-20260914T211500Z-1-001.tgz', buildTarGz(smallFiles(3, 560)));
    const run = h.newRun();
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    hooks.beforeRead = async () => {
      if (!first) {
        return;
      }

      // the share stops answering; the user pauses before the stall limit
      first = false;
      await pauseRun(h, run.id);
      await stuck;
    };
    const done = h.execute(run);
    await until(() => h.run(run.id).status === TakeoutRunStatus.Paused);
    // many ticks, several stall limits
    await sleep(500);
    expect(h.run(run.id).status).toBe(TakeoutRunStatus.Paused);
    release();
    await resumeRun(h, run.id);
    expect(await done).toBe(JobStatus.Success);
    expect(h.run(run.id).status).toBe(TakeoutRunStatus.Completed);
  }, 10_000);

  it('stays paused across a restart; Resume queues it again and a zip part continues at its next entry', async () => {
    const { fs, hooks } = countingFs();
    const h = await harness({ fs, limits: { readChunk: 1 * KiB, readaheadDepth: 1, flushRows: 1000 } });
    h.sut.progressMs = 30;
    // entries large enough that the zip tail read for the central directory (64 KiB) stays clear of the first ones
    const files = Array.from({ length: 20 }, (_, i) => ({
      name: media(`v${i}.mp4`),
      data: randomBytesSeeded(8 * KiB, 580 + i),
    }));
    const zip = buildZip(files.map((file) => ({ nameBytes: Buffer.from(file.name), data: file.data, method: 0 })));
    const part = await h.addPart('takeout-20260914T211500Z-1-001.zip', zip);
    const run = h.newRun();
    const reads: Array<{ attempt: number; position: number; bytes: number }> = [];
    let attempt = 0;
    // reads from here on belong to the central directory (the tail search reads the last 64 KiB)
    const tail = zip.length - 65_557;
    hooks.afterRead = (position, bytes) => {
      reads.push({ attempt, position, bytes });
      const inEntries = position >= 48 * KiB && position < tail;
      if (attempt === 0 && inEntries && h.run(run.id).status === TakeoutRunStatus.Reading) {
        void pauseRun(h, run.id);
      }
    };
    const first = h.execute(run);
    // the pause stores the rows read so far, and the write-behind settles while paused
    await until(
      () =>
        h.run(run.id).status === TakeoutRunStatus.Paused &&
        h.repo.entries.some((entry) => entry.partId === part.id) &&
        h.sut.processResources!.writes.pending(run.id) === 0,
    );
    // the process dies while paused: the job stops without cleaning anything up
    (h.sut as any).controllers.get(run.id).abort(new LeaseLost());
    expect(await first).toBe(JobStatus.Skipped);

    // the new process boots: the run stays paused and is not queued, its lease is gone
    const api = newTestService(TakeoutService, { takeout: h.repo as any });
    // (the storage mock of a new service points the media location elsewhere)
    StorageCore.setMediaLocation(h.dir);
    api.mocks.user.getList.mockResolvedValue([]);
    api.mocks.job.queue.mockResolvedValue();
    api.mocks.job.removeJob.mockResolvedValue();
    api.mocks.storage.checkDiskUsage.mockResolvedValue({ available: 1e13, free: 1e13, total: 1e13 });
    vi.spyOn(api.sut, 'sweepStaging').mockResolvedValue();
    await api.sut.recoverAtBoot();
    expect(h.run(run.id)).toMatchObject({ status: TakeoutRunStatus.Paused, leaseToken: null, heartbeatAt: null });
    expect(api.mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.TakeoutRun }));
    expect(part.catalogStatus).toBe(TakeoutCatalogStatus.Partial);
    const committed = h.repo.entries.filter((entry) => entry.partId === part.id);
    expect(committed.length).toBeGreaterThan(0);
    expect(committed.length).toBeLessThan(20);
    const committedEnd = Math.max(...committed.map((entry) => Number(entry.endOffset)));

    // Resume: no live job, so the run is queued again with the next attempt
    const resumed = await api.sut.resumeRun({ user: { id: userId } } as any, run.id);
    expect(resumed).toMatchObject({ status: TakeoutRunStatus.Queued, pausedAt: null });
    expect(api.mocks.job.removeJob).toHaveBeenCalledWith(JobName.TakeoutRun, `${run.id}/0`);
    expect(api.mocks.job.queue).toHaveBeenCalledWith({
      name: JobName.TakeoutRun,
      data: { runId: run.id, attempt: 1 },
    });
    expect(h.run(run.id).readStats.pausedMs).toBeGreaterThan(0);
    expect(Object.values(h.run(run.id).readStats.parts).map((ps: any) => ps.status)).toEqual(['pending']);

    attempt = 1;
    expect(await h.execute({ id: run.id, attempt: 1 })).toBe(JobStatus.Success);
    expect(h.run(run.id).status).toBe(TakeoutRunStatus.Completed);
    expect(h.repo.assets).toHaveLength(20);
    // the zip continued after its committed entries: no byte of them is read again (the central directory is)
    const again = reads.filter((read) => read.attempt === 1 && read.position < committedEnd && read.position < tail);
    expect(again).toEqual([]);
    expect(h.run(run.id).readStats.fetchFiles).toBe(0);
    const [ps] = Object.values(h.run(run.id).readStats.parts) as any[];
    expect(ps).toMatchObject({ status: 'read', passes: 2 });
  });

  describe('a paused run that holds every place of the Takeout queue while jobs wait for one', () => {
    it('gives its place back after the grace period, stays paused, and Resume queues it again', async () => {
      const { h, run } = await parkedHarness(610);
      const done = h.execute(run);
      await until(() => h.run(run.id).status === TakeoutRunStatus.Paused);
      // longer than the grace period, but nothing waits: the job keeps its place and its open reads
      await sleep(300);
      expect(h.run(run.id).leaseToken).not.toBeNull();

      h.mocks.job.getJobCounts.mockResolvedValue({ waiting: 1 } as any);
      expect(await done).toBe(JobStatus.Skipped);
      const parked = h.run(run.id);
      expect(parked).toMatchObject({ status: TakeoutRunStatus.Paused, leaseToken: null, heartbeatAt: null });
      expect(mapRun(parked)).toMatchObject({ pausedFrom: TakeoutRunStatus.Reading, pausedAt: expect.any(String) });
      expect(Object.values(parked.readStats.parts).map((ps: any) => ps.status)).toEqual(['pending']);
      expect(h.repo.parts[0].catalogStatus).toBe(TakeoutCatalogStatus.Partial);
      expect(h.mocks.job.getJobCounts).toHaveBeenCalledWith(QueueName.Takeout);

      // like a paused run after a restart: Resume queues it again, and the next attempt completes it
      const api = bootedApi(h);
      const resumed = await api.sut.resumeRun({ user: { id: userId } } as any, run.id);
      expect(resumed).toMatchObject({ status: TakeoutRunStatus.Queued, pausedAt: null });
      expect(api.mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.TakeoutRun,
        data: { runId: run.id, attempt: 1 },
      });
      expect(await h.execute({ id: run.id, attempt: 1 })).toBe(JobStatus.Success);
      expect(h.run(run.id).status).toBe(TakeoutRunStatus.Completed);
      expect(h.repo.assets).toHaveLength(20);
    });

    it('keeps its place while not every place of the queue is paused', async () => {
      const { h, run } = await parkedHarness(640);
      h.sut.queueConcurrency = 2;
      h.mocks.job.getJobCounts.mockResolvedValue({ waiting: 3 } as any);
      const done = h.execute(run);
      await until(() => h.run(run.id).status === TakeoutRunStatus.Paused);
      await sleep(300);
      expect(h.run(run.id).leaseToken).not.toBeNull();
      await resumeRun(h, run.id);
      expect(await done).toBe(JobStatus.Success);
      expect(h.run(run.id).status).toBe(TakeoutRunStatus.Completed);
    });

    it('queues the run again when it is resumed while it gives its place back', async () => {
      const { h, run } = await parkedHarness(670);
      const finish = h.repo.finishRunCas.bind(h.repo);
      const spy = vi.spyOn(h.repo, 'finishRunCas').mockImplementation(async (id, from, token, status, patch) => {
        if (status === TakeoutRunStatus.Paused) {
          // the user resumes while the job still holds the lease: the live-job resume wins the check-and-set
          expect(await h.repo.resumePausedRun(id)).toBe(true);
        }
        return finish(id, from, token, status, patch);
      });
      const done = h.execute(run);
      await until(() => h.run(run.id).status === TakeoutRunStatus.Paused);
      h.mocks.job.getJobCounts.mockResolvedValue({ waiting: 1 } as any);
      expect(await done).toBe(JobStatus.Skipped);
      expect(h.run(run.id)).toMatchObject({ status: TakeoutRunStatus.Queued, leaseToken: null, attempt: 1 });
      expect(h.mocks.job.queue).toHaveBeenCalledWith({ name: JobName.TakeoutRun, data: { runId: run.id, attempt: 1 } });
      spy.mockRestore();
      expect(await h.execute({ id: run.id, attempt: 1 })).toBe(JobStatus.Success);
      expect(h.repo.assets).toHaveLength(20);
    });
  });

  it('applies changed read settings to a running run: reader count, readahead and the read limit', async () => {
    const { fs, counts, hooks } = countingFs();
    const h = await harness({ fs, limits: { readChunk: 1 * KiB, readaheadDepth: 2 } });
    h.sut.progressMs = 30;
    for (const n of [1, 2]) {
      await h.addPart(
        `takeout-20260914T211500Z-1-00${n}.tgz`,
        buildTarGz([{ name: media(`v${n}.mp4`), data: randomBytesSeeded(30 * KiB, 600 + n) }]),
        n,
      );
    }
    const run = h.newRun();
    let seen: { readers: number; readaheadDepth: number } | null = null;
    hooks.afterRead = () => {
      if (counts.reads !== 6) {
        return;
      }

      h.sut.onConfigUpdate({
        newConfig: { takeout: { readers: 1, throttleMBps: 500, readaheadDepth: 1 } },
      } as any);
      const ctx = (h.sut as any).attempts.get(run.id).ctx;
      seen = { readers: ctx.readers, readaheadDepth: ctx.readaheadDepth };
    };
    expect(await h.execute(run)).toBe(JobStatus.Success);
    expect(seen).toEqual({ readers: 1, readaheadDepth: 1 });
    expect(h.sut.processResources!.throttle.rateMBps).toBe(500);
    expect(h.run(run.id).readStats).toMatchObject({ readers: 1, readahead: 1 });
    for (const ps of Object.values(h.run(run.id).readStats.parts) as any[]) {
      expect(ps).toMatchObject({ status: 'read', passes: 1, bytesRead: ps.size });
    }
  });
});
