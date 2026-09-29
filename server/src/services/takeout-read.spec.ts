import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { TakeoutCatalogStatus, TakeoutRunStatus } from 'src/enum';
import {
  CancelReason,
  DEFAULT_READ_LIMITS,
  EntryBatch,
  FetchRequest,
  ProcessResources,
  ReadContext,
  ReadLimits,
  ReadPartRow,
  ReadStatsTracker,
  RunFailure,
  SpaceBudget,
  WriteQueue,
  createProcessResources,
  fetchEntries,
  readPartWithRetry,
  readerPool,
  recountReadStats,
  sha1,
} from 'src/services/takeout-read';
import { StagingFs, StagingStore, nodeStagingFs } from 'src/services/takeout-staging';
import { FileHandleLike, FileSourceFs, hex, newReadMeter, nodeFileSourceFs } from 'src/takeout';
import { buildTar, buildTarGz, buildZip, randomBytesSeeded } from 'src/takeout/test-fixtures';
import { TakeoutMemoryRepository } from 'test/fixtures/takeout-memory.repository';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KiB = 1024;
const userId = 'user-1';
const logger = { log: () => {}, warn: () => {}, error: () => {} };

const limits = (over: Partial<ReadLimits> = {}): ReadLimits => ({
  ...DEFAULT_READ_LIMITS,
  readers: 3,
  bufferLimit: 1 * KiB,
  sampleBufferLimit: 4 * KiB,
  probeBytes: 256,
  readChunk: 4 * KiB,
  readaheadDepth: 2,
  memoryBudget: 1024 * KiB,
  flushRows: 3,
  flushIntervalMs: 60_000,
  zipSeekGap: 1 * KiB,
  freeSpaceReserve: 0,
  transportRetryBudgetMs: 0,
  ioRetries: [1],
  cancelReaderCapMs: 200,
  cancelWriteCapMs: 200,
  stableAgeMs: -60_000,
  throttleMBps: null,
  ...over,
});

const media = (name: string) => `Takeout/Google Photos/${name}`;

interface Harness {
  dir: string;
  userFolder: string;
  repo: TakeoutMemoryRepository;
  run: any;
  exportId: string;
  staging: StagingStore;
  ctx: ReadContext;
  resources: ProcessResources;
  controller: AbortController;
  limits: ReadLimits;
}

let dirs: string[] = [];
beforeEach(() => {
  dirs = [];
});
afterEach(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function harness(
  options: {
    limits?: Partial<ReadLimits>;
    fs?: FileSourceFs;
    stagingFs?: StagingFs;
    statfs?: () => Promise<number>;
    quotaLimit?: number | null;
    readStats?: unknown;
    prepare?: (repo: TakeoutMemoryRepository, dir: string) => Promise<void> | void;
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'takeout-read-'));
  dirs.push(dir);
  const userFolder = join(dir, 'takeouts', 'me');
  await mkdir(userFolder, { recursive: true });
  const repo = new TakeoutMemoryRepository();
  const exp = repo.addExport({ userId });
  const run = repo.addRun({
    userId,
    exportId: exp.id,
    status: TakeoutRunStatus.Reading,
    leaseToken: 'token',
    readStats: options.readStats ?? {},
  });
  await options.prepare?.(repo, dir);
  const l = limits(options.limits);
  const resources = createProcessResources(l);
  const staging = await StagingStore.open(run, userFolder, join(dir, 'upload', userId), {
    repo: repo as any,
    assets: repo.assetRepository(),
    fs: options.stagingFs,
  });
  const controller = new AbortController();
  const ctx = new ReadContext({
    run: run as any,
    deps: { repo: repo as any, logger, fs: options.fs },
    limits: l,
    resources,
    staging,
    stats: new ReadStatsTracker(run.readStats),
    partPath: (fileName) => join(userFolder, fileName),
    signal: controller.signal,
  });
  await ctx.prepareReading({
    deletedSkip: false,
    quotaLimit: options.quotaLimit ?? null,
    quotaUsage: 0,
    statfs: options.statfs ?? (() => Promise.resolve(1e12)),
  });
  ctx.sampleSet = new Set();
  return { dir, userFolder, repo, run, exportId: exp.id, staging, ctx, resources, controller, limits: l };
}

async function addPart(h: Harness, fileName: string, bytes: Buffer, partNumber = 1): Promise<ReadPartRow> {
  const path = join(h.userFolder, fileName);
  await writeFile(path, bytes);
  const st = await stat(path);
  const part = h.repo.addPart({
    exportId: h.exportId,
    userId,
    fileName,
    partNumber,
    size: st.size,
    mtime: st.mtime,
    ctime: st.ctime,
  });
  return (await h.repo.getPart(part.id)) as ReadPartRow;
}

function readAll(h: Harness, parts: ReadPartRow[], n = 3) {
  return readerPool(h.ctx, parts, n, (part, token) => readPartWithRetry(h.ctx, part, token));
}

const entriesOf = (h: Harness, partId: string) =>
  h.repo.entries.filter((e) => e.partId === partId).toSorted((a, b) => a.seq - b.seq);

async function blobExists(h: Harness, content: Buffer) {
  return stat(h.staging.blobPath(hex(sha1(content))))
    .then(() => true)
    .catch(() => false);
}

describe('reading: content addressing', () => {
  it('writes one blob for the same bytes under two paths and in two parts', async () => {
    const h = await harness();
    const content = randomBytesSeeded(500, 1);
    const tgz = await addPart(
      h,
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([
        { name: media('Album A/X.mp4'), data: content },
        { name: media('Photos from 2020/X.mp4'), data: content },
      ]),
      1,
    );
    const zip = await addPart(
      h,
      'takeout-20260914T211500Z-1-002.zip',
      buildZip([{ nameBytes: Buffer.from(media('Other/X.mp4')), data: content, method: 0 }]),
      2,
    );
    const writes = vi.spyOn(h.staging, 'writeBuffer');
    await readAll(h, [tgz, zip]);

    expect(writes).toHaveBeenCalledTimes(1);
    expect(await blobExists(h, content)).toBe(true);
    const rows = [...entriesOf(h, tgz.id), ...entriesOf(h, zip.id)];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.checksum).toEqual(sha1(content));
    }
    expect(h.ctx.stats.stats.stagedFiles).toBe(1);
    expect(h.ctx.stats.stats.localDuplicatesSkipped).toBe(2);
    expect(h.repo.parts.every((p) => p.catalogStatus === TakeoutCatalogStatus.Complete)).toBe(true);
    expect(h.staging.pendingReservations()).toBe(0);
  });

  it('marks a part complete only once the blobs of its entries are written (a crash then needs no fetch)', async () => {
    const h = await harness();
    const contents = [0, 1, 2, 3].map((i) => randomBytesSeeded(500, 40 + i));
    const part = await addPart(
      h,
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz(contents.map((data, i) => ({ name: media(`${i}.jpg`), data }))),
    );
    // slow staging writes: the reader reaches the end of the part while its blobs are still queued
    const write = h.staging.writeBuffer.bind(h.staging);
    vi.spyOn(h.staging, 'writeBuffer').mockImplementation(async (reservation, buf) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return write(reservation, buf);
    });
    const blobsAtComplete: boolean[] = [];
    const complete = h.repo.completePart.bind(h.repo);
    vi.spyOn(h.repo, 'completePart').mockImplementation(async (...args: Parameters<typeof complete>) => {
      for (const content of contents) {
        blobsAtComplete.push(await blobExists(h, content));
      }
      return complete(...args);
    });

    await readAll(h, [part]);
    expect(blobsAtComplete).toEqual([true, true, true, true]);
    expect(h.repo.parts[0].catalogStatus).toBe(TakeoutCatalogStatus.Complete);
  });

  it('does not stage a file whose checksum is on the server', async () => {
    const content = randomBytesSeeded(500, 2);
    const h = await harness({
      prepare: (repo) => {
        repo.addAsset({ ownerId: userId, checksum: sha1(content), originalPath: '/nowhere' });
      },
    });
    const part = await addPart(
      h,
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([{ name: media('a.mp4'), data: content }]),
    );
    await readAll(h, [part]);
    expect(await blobExists(h, content)).toBe(false);
    expect(h.ctx.stats.stats.serverDuplicatesSkipped).toBe(1);
    expect(entriesOf(h, part.id)[0].checksum).toEqual(sha1(content));
  });
});

describe('reading: large entries and the prefix probe', () => {
  const size = 3 * KiB;

  it('streams a large entry whose same-size server asset has a different first bytes', async () => {
    const content = randomBytesSeeded(size, 3);
    const other = randomBytesSeeded(size, 4);
    const h = await harness({
      prepare: async (repo, dir) => {
        await writeFile(join(dir, 'server.mp4'), other);
        repo.addAsset({
          ownerId: userId,
          checksum: sha1(other),
          originalPath: join(dir, 'server.mp4'),
          fileSizeInByte: size,
        });
      },
    });
    const part = await addPart(
      h,
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([{ name: media('big.mp4'), data: content }]),
    );
    await readAll(h, [part]);
    expect(await blobExists(h, content)).toBe(true);
    expect(h.ctx.stats.stats.stagedFiles).toBe(1);
    expect(h.ctx.stats.stats.deferredFiles).toBe(0);
  });

  it('defers a large entry with the same first bytes but other content, and fetching stages it', async () => {
    const server = randomBytesSeeded(size, 5);
    const content = Buffer.concat([server.subarray(0, 1024), randomBytesSeeded(size - 1024, 6)]);
    const h = await harness({
      prepare: async (repo, dir) => {
        await writeFile(join(dir, 'server.mp4'), server);
        repo.addAsset({
          ownerId: userId,
          checksum: sha1(server),
          originalPath: join(dir, 'server.mp4'),
          fileSizeInByte: size,
        });
      },
    });
    const filler = randomBytesSeeded(40 * KiB, 7);
    const zip = await addPart(
      h,
      'takeout-20260914T211500Z-1-001.zip',
      buildZip([
        { nameBytes: Buffer.from(media('big.mp4')), data: content, method: 0 },
        { nameBytes: Buffer.from(media('filler.bin')), data: filler, method: 0 },
      ]),
    );
    const tgz = await addPart(
      h,
      'takeout-20260914T211500Z-1-002.tgz',
      buildTarGz([
        { name: media('big-copy.mp4'), data: content },
        { name: media('after.bin'), data: randomBytesSeeded(200 * KiB, 8) },
      ]),
      2,
    );
    await readAll(h, [zip, tgz]);
    expect(await blobExists(h, content)).toBe(false);
    expect(h.ctx.stats.stats.deferredFiles).toBe(2);

    // the plan needs it: fetched from the cheapest occurrence (zip), reading only that entry
    const found = await h.repo.getEntryOccurrences(h.exportId, [sha1(content)], 2);
    const occurrences = found.map((o) => ({
      partName: o.partName,
      kind: o.kind,
      seq: o.seq,
      path: o.path,
      size: Number(o.size),
      endOffset: o.endOffset,
    }));
    const request: FetchRequest = {
      kind: 'blob',
      checksum: sha1(content),
      size,
      occurrences,
      cursor: 0,
      satisfied: false,
      failure: null,
    };
    const exportParts = await h.repo.getPartsByExport(h.exportId);
    const parts = new Map(exportParts.map((p) => [p.fileName, p as unknown as ReadPartRow]));
    const unserved = await fetchEntries(h.ctx, parts, [request]);
    expect(unserved).toEqual([]);
    expect(await blobExists(h, content)).toBe(true);
    const zipStats = h.ctx.stats.stats.parts[zip.id];
    expect(zipStats.fetchBytesRead).toBeLessThan(size + 70 * KiB);
    expect(h.ctx.stats.stats.fetchFiles).toBe(1);
  });

  it('fetches from a tgz and stops after the entry', async () => {
    const content = randomBytesSeeded(size, 9);
    const h = await harness();
    const tail = randomBytesSeeded(300 * KiB, 10);
    const gz = buildTarGz([
      { name: media('big.mp4'), data: content },
      { name: media('tail.bin'), data: tail },
    ]);
    const tgz = await addPart(h, 'takeout-20260914T211500Z-1-001.tgz', gz);
    h.repo.parts[0].catalogVersion = 2;
    h.repo.parts[0].catalogStatus = TakeoutCatalogStatus.Complete;
    h.repo.parts[0].catalogSize = tgz.size;
    h.repo.parts[0].catalogMtime = tgz.mtime;
    h.repo.entries.push({
      id: 1,
      exportId: h.exportId,
      partId: tgz.id,
      seq: 0,
      path: media('big.mp4'),
      size,
      kind: 'media',
      checksum: sha1(content),
      endOffset: 4 * KiB,
    });
    const part = (await h.repo.getPart(tgz.id)) as unknown as ReadPartRow;
    const request: FetchRequest = {
      kind: 'blob',
      checksum: sha1(content),
      size,
      occurrences: [{ partName: part.fileName, kind: 'tgz', seq: 0, path: media('big.mp4'), size, endOffset: 4 * KiB }],
      cursor: 0,
      satisfied: false,
      failure: null,
    };
    expect(await fetchEntries(h.ctx, new Map([[part.fileName, part]]), [request])).toEqual([]);
    expect(await blobExists(h, content)).toBe(true);
    expect(h.ctx.stats.stats.parts[tgz.id].fetchBytesRead).toBeLessThan(gz.length);
  });

  it('never stages or fetches a large entry whose content is on the server', async () => {
    const content = randomBytesSeeded(size, 11);
    const h = await harness({
      prepare: async (repo, dir) => {
        await writeFile(join(dir, 'server.mp4'), content);
        repo.addAsset({
          ownerId: userId,
          checksum: sha1(content),
          originalPath: join(dir, 'server.mp4'),
          fileSizeInByte: size,
        });
      },
    });
    const part = await addPart(
      h,
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([{ name: media('big.mp4'), data: content }]),
    );
    await readAll(h, [part]);
    expect(await blobExists(h, content)).toBe(false);
    expect(h.ctx.stats.stats.serverDuplicatesSkipped).toBe(1);
    expect(h.ctx.stats.stats.deferredFiles).toBe(0);
  });
});

describe('reading: resume', () => {
  it('continues a zip after its last committed entry', async () => {
    const files = Array.from({ length: 6 }, (_, i) => ({
      nameBytes: Buffer.from(media(`f${i}.mp4`)),
      data: randomBytesSeeded(500, 20 + i),
      method: 0 as const,
    }));
    const h = await harness();
    const part = await addPart(h, 'takeout-20260914T211500Z-1-001.zip', buildZip(files));
    Object.assign(h.repo.parts[0], {
      catalogStatus: TakeoutCatalogStatus.Partial,
      catalogVersion: 2,
      catalogSize: part.size,
      catalogMtime: part.mtime,
    });
    for (let seq = 0; seq < 3; seq++) {
      h.repo.entries.push({
        id: 100 + seq,
        exportId: h.exportId,
        partId: part.id,
        seq,
        path: media(`f${seq}.mp4`),
        size: 500,
        kind: 'media',
        checksum: sha1(files[seq].data),
      });
    }
    const fresh = (await h.repo.getPart(part.id)) as unknown as ReadPartRow;
    await readAll(h, [fresh]);
    expect(h.ctx.stats.stats.filesFound).toBe(3);
    const rows = entriesOf(h, part.id);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows.slice(0, 3).map((r) => r.id)).toEqual([100, 101, 102]);
    expect(h.repo.parts[0].catalogStatus).toBe(TakeoutCatalogStatus.Complete);
    expect(h.repo.parts[0].entryCount).toBe(6);
  });

  it('restarts a tgz from byte 0, hashing only new entries and the entry whose blob was lost', async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      name: media(`t${i}.mp4`),
      data: randomBytesSeeded(500, 40 + i),
    }));
    const first = await harness();
    const part = await addPart(first, 'takeout-20260914T211500Z-1-001.tgz', buildTarGz(files));
    await readAll(first, [part]);
    expect(entriesOf(first, part.id)).toHaveLength(5);

    // crash state: rows 3 and 4 were never committed, the blob of entry 1 was lost
    first.repo.entries = first.repo.entries.filter((e) => e.seq < 3);
    first.repo.parts[0].catalogStatus = TakeoutCatalogStatus.Partial;
    await unlink(first.staging.blobPath(hex(sha1(files[1].data))));

    const staging = await StagingStore.open(first.run, first.userFolder, join(first.dir, 'upload', userId), {
      repo: first.repo as any,
      assets: first.repo.assetRepository(),
    });
    const ctx = new ReadContext({
      run: first.run,
      deps: { repo: first.repo as any, logger },
      limits: first.limits,
      resources: createProcessResources(first.limits),
      staging,
      stats: new ReadStatsTracker({}),
      partPath: (fileName) => join(first.userFolder, fileName),
      signal: new AbortController().signal,
    });
    await ctx.prepareReading({
      deletedSkip: false,
      quotaLimit: null,
      quotaUsage: 0,
      statfs: () => Promise.resolve(1e12),
    });
    ctx.sampleSet = new Set();
    const streamed = vi.spyOn(staging, 'streamToTemp');
    const fresh = (await first.repo.getPart(part.id)) as unknown as ReadPartRow;
    await readerPool(ctx, [fresh], 1, (p, token) => readPartWithRetry(ctx, p, token));

    expect(ctx.stats.stats.filesFound).toBe(2);
    expect(streamed).toHaveBeenCalledTimes(1);
    expect(await readFile(staging.blobPath(hex(sha1(files[1].data))))).toEqual(files[1].data);
    expect(entriesOf(first, part.id).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(ctx.stats.stats.parts[part.id].passes).toBe(1);
  });

  it('reads a tgz fresh once when a committed entry differs, and fails the run on a second change', async () => {
    const files = Array.from({ length: 3 }, (_, i) => ({
      name: media(`c${i}.mp4`),
      data: randomBytesSeeded(300, 60 + i),
    }));
    const h = await harness();
    const part = await addPart(h, 'takeout-20260914T211500Z-1-001.tgz', buildTarGz(files));
    Object.assign(h.repo.parts[0], {
      catalogStatus: TakeoutCatalogStatus.Partial,
      catalogVersion: 2,
      catalogSize: part.size,
      catalogMtime: part.mtime,
    });
    // same key, other content: the committed row does not match what the archive holds now
    h.repo.entries.push({
      id: 1,
      exportId: h.exportId,
      partId: part.id,
      seq: 0,
      path: media('other.mp4'),
      size: 300,
      kind: 'media',
      checksum: sha1(Buffer.from('x')),
    });
    const fresh = (await h.repo.getPart(part.id)) as unknown as ReadPartRow;
    await readAll(h, [fresh]);
    expect(entriesOf(h, part.id).map((r) => r.path)).toEqual(files.map((f) => f.name));
    expect(h.repo.parts[0].catalogStatus).toBe(TakeoutCatalogStatus.Complete);

    // a file that changes under every read: one fresh read, then a resumable failure
    const changing: FileSourceFs = {
      open: async (path) => {
        const real = await nodeFileSourceFs.open(path);
        return {
          ...real,
          read: real.read.bind(real),
          close: real.close.bind(real),
          stat: async () => ({ ...(await real.stat()), ino: 424_242 }),
        };
      },
    };
    const h2 = await harness({ fs: changing });
    const part2 = await addPart(h2, 'takeout-20260914T211500Z-1-001.tgz', buildTarGz(files));
    await expect(readAll(h2, [part2])).rejects.toThrow(/changed while it was read/);
  });

  it('reads the new central directory of a zip part replaced between attempts', async () => {
    const oldZip = buildZip([
      { nameBytes: Buffer.from(media('old.mp4')), data: randomBytesSeeded(4000, 70), method: 0 },
    ]);
    const newZip = buildZip([
      { nameBytes: Buffer.from(media('new-a.mp4')), data: randomBytesSeeded(700, 71), method: 0 },
      { nameBytes: Buffer.from(media('new-b.mp4')), data: randomBytesSeeded(700, 72), method: 0 },
    ]);
    let userFolder = '';
    let failed = false;
    const flaky: FileSourceFs = {
      open: async (path) => {
        const real = await nodeFileSourceFs.open(path);
        return {
          read: async (buffer, offset, length, position) => {
            if (!failed && position > 0) {
              failed = true;
              await writeFile(join(userFolder, 'takeout-20260914T211500Z-1-001.zip'), newZip);
              throw Object.assign(new Error('EIO'), { code: 'EIO' });
            }
            return real.read(buffer, offset, length, position);
          },
          stat: () => real.stat(),
          close: () => real.close(),
        } satisfies FileHandleLike;
      },
    };
    const h = await harness({ fs: flaky, limits: { readChunk: 512 } });
    userFolder = h.userFolder;
    const part = await addPart(h, 'takeout-20260914T211500Z-1-001.zip', oldZip);
    await readAll(h, [part]);
    expect(entriesOf(h, part.id).map((r) => r.path)).toEqual([media('new-a.mp4'), media('new-b.mp4')]);
  });

  it('completes the part in the same transaction as its last rows', async () => {
    const h = await harness();
    const part = await addPart(
      h,
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([{ name: media('a.mp4'), data: randomBytesSeeded(100, 80) }]),
    );
    await readAll(h, [part]);
    expect(h.repo.calls.completePart).toBe(1);
    expect(h.repo.parts[0].catalogStatus).toBe(TakeoutCatalogStatus.Complete);
    expect(h.repo.parts[0].entryCount).toBe(1);
  });

  it('keeps statistics seeded from the stored readStats across a restart', async () => {
    const startedAt = '2026-09-28T10:00:00.000Z';
    let partId = '';
    const h = await harness({
      prepare: (repo) => {
        partId = 'p-1';
        void repo;
      },
      readStats: {
        filesFound: 7,
        parts: {
          'p-1': { partId: 'p-1', fileName: 'x.tgz', size: 10, passes: 1, startedAt, status: 'reading', position: 5 },
        },
      },
    });
    const tracker = h.ctx.stats;
    expect(tracker.stats.filesFound).toBe(7);
    const ps = tracker.part({ id: partId, fileName: 'x.tgz', size: 10, segment: 1, partNumber: 1 });
    const grew = tracker.beginPass(
      ps,
      { position: 0, bytesRead: 0, bytesSkipped: 0, transportRetries: 0, pendingSince: null },
      true,
    );
    expect(grew).toBe(5);
    expect(ps.passes).toBe(2);
    expect(ps.passBase).toBe(5);
    expect(ps.startedAt).toBe(startedAt);
  });
});

describe('reading: entry rows', () => {
  it('stores a JSON row that jsonb refuses without its JSON', async () => {
    const h = await harness();
    const json = Buffer.from(JSON.stringify({ title: 'a\u{0}b.jpg', photoTakenTime: { timestamp: '1' } }));
    const part = await addPart(
      h,
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([
        { name: media('a.jpg.json'), data: json },
        { name: media('b.mp4'), data: randomBytesSeeded(100, 90) },
      ]),
    );
    await readAll(h, [part]);
    const rows = entriesOf(h, part.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].json).toBeNull();
    expect(rows[0].jsonError).toMatch(/Unicode/);
    expect(rows[1].checksum).not.toBeNull();
  });

  it('ignores a duplicated flush (unique partId, seq)', async () => {
    const h = await harness();
    const batch = new EntryBatch(h.ctx, { detached: false });
    const row = {
      exportId: h.exportId,
      partId: 'p',
      seq: 0,
      path: 'a',
      size: 1,
      mtime: null,
      kind: 'other',
      checksum: null,
      json: null,
      jsonError: null,
      readError: null,
      width: null,
      height: null,
      sample: null,
      sampleSkipped: null,
      endOffset: null,
    } as any;
    await h.repo.insertEntries([row]);
    await h.repo.insertEntries([row]);
    await batch.push({ ...row });
    await batch.settle();
    expect(h.repo.entries.filter((e) => e.partId === 'p')).toHaveLength(1);
  });

  it('commits a part whose walk ended although a stop kept a sample from being computed', async () => {
    const h = await harness();
    const batch = new EntryBatch(h.ctx, { detached: false });
    await batch.push({
      exportId: h.exportId,
      partId: 'p',
      seq: 0,
      path: media('a.jpg'),
      size: 1,
      mtime: null,
      kind: 'media',
      checksum: Buffer.alloc(20, 1),
      json: null,
      jsonError: null,
      readError: null,
      width: null,
      height: null,
      sample: null,
      sampleSkipped: null,
      endOffset: 1,
      pendingSample: Promise.resolve(null),
    } as any);
    h.controller.abort(new CancelReason());
    const committed: any[] = [];
    await batch.finish((rows) => {
      committed.push(...rows);
      return Promise.resolve();
    });
    // no sample and no sampleSkipped: sample backfill fetches it
    expect(committed).toMatchObject([{ seq: 0, sample: null, sampleSkipped: null }]);
  });

  it('keeps the entries before a cut, records the entry in flight and continues with the other part', async () => {
    const h = await harness();
    const entries = [
      { name: media('one.mp4'), data: randomBytesSeeded(600, 100) },
      { name: media('two.mp4'), data: randomBytesSeeded(900, 101) },
      { name: media('three.bin'), data: randomBytesSeeded(300 * KiB, 102) },
    ];
    const gz = buildTarGz(entries);
    const cut = await addPart(h, 'takeout-20260914T211500Z-1-001.tgz', gz.subarray(0, Math.floor(gz.length * 0.5)), 1);
    const good = await addPart(
      h,
      'takeout-20260914T211500Z-1-002.tgz',
      buildTarGz([{ name: media('fine.mp4'), data: randomBytesSeeded(100, 103) }]),
      2,
    );
    await readAll(h, [cut, good]);

    const cutPart = h.repo.parts.find((p) => p.id === cut.id)!;
    expect(cutPart.catalogStatus).toBe(TakeoutCatalogStatus.Error);
    expect(cutPart.catalogErrorOffset).toBeGreaterThan(0);
    const rows = entriesOf(h, cut.id);
    expect(rows.slice(0, 2).map((r) => r.readError)).toEqual([null, null]);
    expect(rows[2].path).toBe(media('three.bin'));
    expect(rows[2].readError).toMatch(/truncated or corrupt/);
    expect(h.repo.parts.find((p) => p.id === good.id)!.catalogStatus).toBe(TakeoutCatalogStatus.Complete);
  });

  it('excludes a tgz part whose gzip CRC fails', async () => {
    const h = await harness();
    const gz = gzipSync(buildTar([{ name: media('photo.mp4'), data: randomBytesSeeded(3 * 1024 * KiB, 104) }]), {
      level: 0,
    });
    gz[10 + 5 + 4000] ^= 0x01;
    const part = await addPart(h, 'takeout-20260914T211500Z-1-001.tgz', gz);
    await readAll(h, [part]);
    const row = h.repo.parts[0];
    expect(row.catalogStatus).toBe(TakeoutCatalogStatus.Error);
    expect(row.catalogError).toMatch(/^gzip CRC mismatch/);
    expect(entriesOf(h, part.id)).toEqual([]);
  });

  it('records a zip entry with a bad CRC and reads the rest of the part', async () => {
    const h = await harness();
    const part = await addPart(
      h,
      'takeout-20260914T211500Z-1-001.zip',
      buildZip([
        { nameBytes: Buffer.from(media('a.mp4')), data: randomBytesSeeded(300, 110), method: 0 },
        { nameBytes: Buffer.from(media('bad.mp4')), data: randomBytesSeeded(300, 111), method: 0, crcOverride: 42 },
        { nameBytes: Buffer.from(media('c.mp4')), data: randomBytesSeeded(300, 112), method: 0 },
      ]),
    );
    await readAll(h, [part]);
    const rows = entriesOf(h, part.id);
    expect(rows.map((r) => r.readError)).toEqual([null, 'CRC-32 mismatch', null]);
    expect(rows[1].checksum).toBeNull();
    expect(rows[1].kind).toBe('other');
    expect(h.repo.parts[0].catalogStatus).toBe(TakeoutCatalogStatus.Complete);
    expect(h.ctx.stats.stats.parts[part.id].entryErrors).toBe(1);
  });
});

describe('reading: failures, cancel and budgets', () => {
  it('aborts the other readers on the first failure and writes nothing after it', async () => {
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    const fs: FileSourceFs = {
      open: async (path) => {
        const real = await nodeFileSourceFs.open(path);
        const broken = path.endsWith('-001.tgz');
        const slow = path.endsWith('-002.tgz');
        return {
          read: async (buffer, offset, length, position) => {
            if (broken) {
              throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            }
            if (slow && position > 0) {
              await stuck;
            }
            return real.read(buffer, offset, length, position);
          },
          stat: () => real.stat(),
          close: () => real.close(),
        };
      },
    };
    const h = await harness({ fs, limits: { ioRetries: [], readChunk: 1 * KiB } });
    const a = await addPart(
      h,
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([{ name: media('a.mp4'), data: randomBytesSeeded(100, 120) }]),
      1,
    );
    const b = await addPart(
      h,
      'takeout-20260914T211500Z-1-002.tgz',
      buildTarGz(
        Array.from({ length: 5 }, (_, i) => ({ name: media(`b${i}.mp4`), data: randomBytesSeeded(900, 130 + i) })),
      ),
      2,
    );
    await expect(readAll(h, [a, b])).rejects.toBeInstanceOf(RunFailure);
    const rowsAfterFailure = h.repo.entries.length;
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.repo.entries.length).toBe(rowsAfterFailure);
    expect(h.ctx.readAbort.signal.aborted).toBe(true);
  });

  it('turns ENOSPC of a write-behind into a RunFailure without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const stagingFs: StagingFs = {
        ...nodeStagingFs,
        open: (async (path: string, flags: string) => {
          const handle = await nodeStagingFs.open(path, flags);
          if (flags === 'wx' && !path.includes('probe')) {
            return Object.assign(handle, {
              write: () => Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' })),
            });
          }
          return handle;
        }) as any,
      };
      const h = await harness({ stagingFs });
      const part = await addPart(
        h,
        'takeout-20260914T211500Z-1-001.tgz',
        buildTarGz(
          Array.from({ length: 8 }, (_, i) => ({ name: media(`n${i}.mp4`), data: randomBytesSeeded(400, 140 + i) })),
        ),
      );
      await expect(readAll(h, [part])).rejects.toThrow('Not enough free space');
      // the reader either stopped at its next entry (part left 'reading') or had finished (the blob is fetched later)
      expect([TakeoutCatalogStatus.Reading, TakeoutCatalogStatus.Complete]).toContain(h.repo.parts[0].catalogStatus);
      expect(h.staging.pendingReservations()).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('stops within a second on cancel inside a large entry and leaves no temp file', async () => {
    const fs: FileSourceFs = {
      open: async (path) => {
        const real = await nodeFileSourceFs.open(path);
        return {
          read: async (buffer, offset, length, position) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return real.read(buffer, offset, length, position);
          },
          stat: () => real.stat(),
          close: () => real.close(),
        };
      },
    };
    const h = await harness({ fs, limits: { readChunk: 1 * KiB, readaheadDepth: 1 } });
    const part = await addPart(
      h,
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz([{ name: media('huge.mp4'), data: randomBytesSeeded(2048 * KiB, 150) }]),
    );
    const reading = readAll(h, [part]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const cancelledAt = Date.now();
    h.controller.abort(new CancelReason());
    await expect(reading).rejects.toBeInstanceOf(CancelReason);
    expect(Date.now() - cancelledAt).toBeLessThan(1000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readdir(join(h.staging.dir, '.tmp'))).toEqual([]);
  });

  it('defers entries beyond the free space and stages again when there is room', async () => {
    const h = await harness({ statfs: () => Promise.resolve(1000) });
    const files = Array.from({ length: 4 }, (_, i) => ({
      name: media(`s${i}.mp4`),
      data: randomBytesSeeded(400, 160 + i),
    }));
    const part = await addPart(h, 'takeout-20260914T211500Z-1-001.tgz', buildTarGz(files));
    await readAll(h, [part]);
    expect(h.ctx.stats.stats.stagedFiles).toBe(2);
    expect(h.ctx.stats.stats.deferredFiles).toBe(2);
    expect(h.repo.parts[0].catalogStatus).toBe(TakeoutCatalogStatus.Complete);
  });

  it('stops staging at the quota and defers the rest', async () => {
    const h = await harness({ quotaLimit: 900 });
    const files = Array.from({ length: 4 }, (_, i) => ({
      name: media(`q${i}.mp4`),
      data: randomBytesSeeded(400, 170 + i),
    }));
    const part = await addPart(h, 'takeout-20260914T211500Z-1-001.tgz', buildTarGz(files));
    await readAll(h, [part]);
    expect(h.ctx.stats.stats.stagedFiles).toBe(2);
    expect(h.ctx.stats.stats.deferredFiles).toBe(2);
  });

  it('never holds more memory than the budget with three readers', async () => {
    // 3 readers x (1 + 1) x 4 KiB of readahead, plus room for the entry buffers
    const h = await harness({ limits: { memoryBudget: 28 * KiB, readChunk: 4 * KiB, readaheadDepth: 1 } });
    const parts: ReadPartRow[] = [];
    for (let p = 0; p < 3; p++) {
      parts.push(
        await addPart(
          h,
          `takeout-20260914T211500Z-1-00${p + 1}.tgz`,
          buildTarGz(
            Array.from({ length: 6 }, (_, i) => ({
              name: media(`m${p}-${i}.mp4`),
              data: randomBytesSeeded(900, 200 + p * 10 + i),
            })),
          ),
          p + 1,
        ),
      );
    }
    await readAll(h, parts, 3);
    expect(h.resources.memory.peak).toBeLessThanOrEqual(28 * KiB);
    expect(h.resources.memory.held).toBe(0);
    expect(h.resources.writes.peakInFlight).toBeLessThanOrEqual(2);
  });
});

describe('reading: samples of a stopped read', () => {
  it('never records a sample the stop kept from being computed as a decode error', async () => {
    let reads = 0;
    const fs: FileSourceFs = {
      open: async (path) => {
        const real = await nodeFileSourceFs.open(path);
        return {
          read: async (buffer, offset, length, position) => {
            reads++;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return real.read(buffer, offset, length, position);
          },
          stat: () => real.stat(),
          close: () => real.close(),
        };
      },
    };
    const h = await harness({
      fs,
      limits: { readers: 1, bufferLimit: 64 * KiB, sampleBufferLimit: 64 * KiB, readChunk: 1 * KiB, readaheadDepth: 1 },
    });
    h.ctx.sampleSet = 'all';
    // both sampler slots busy: the samples of this read wait for one when the stop comes
    const slots = (h.resources.sampler as any).slots;
    await slots.acquire(1);
    await slots.acquire(1);
    const jpegs = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        sharp({ create: { width: 32, height: 16, channels: 3, background: { r: 10 * i, g: 50, b: 90 } } })
          .jpeg()
          .toBuffer(),
      ),
    );
    const part = await addPart(
      h,
      'takeout-20260914T211500Z-1-001.tgz',
      buildTarGz(jpegs.map((data, i) => ({ name: media(`A/p${i}.jpg`), data }))),
    );
    const reading = readAll(h, [part], 1);
    for (let i = 0; i < 200 && h.ctx.stats.stats.mediaFound < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    h.controller.abort(new CancelReason());
    await expect(reading).rejects.toBeInstanceOf(CancelReason);
    expect(reads).toBeGreaterThan(0);

    const rows = entriesOf(h, part.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.sampleSkipped === 'decodeError')).toBe(false);
    expect(rows.some((row) => !row.sample)).toBe(true);
    // every stored image without a sample is still a sample backfill candidate
    const candidates = await h.repo.getEntriesWithoutSample(h.exportId);
    expect(candidates.length).toBe(rows.filter((row) => !row.sample).length);
  });

  it('decodes from its own budget, never behind the buffers and readahead that fill the memory budget', async () => {
    const resources = createProcessResources({ ...limits(), memoryBudget: 64 * KiB, decodeBudget: 64 * KiB });
    // the buffer budget is full (buffers of pending samples, the readahead of the readers)
    const held = await resources.memory.acquire(64 * KiB);
    const jpeg = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#808080' } })
      .jpeg()
      .toBuffer();
    // 400 x 400 x 4 bytes is larger than the decode budget: admitted when no other decode runs
    const result = await resources.sampler.sample(jpeg, null);
    expect(result).toMatchObject({ width: 400, height: 400 });
    expect(resources.decode.held).toBe(0);
    held.release();
    expect(resources.memory.held).toBe(0);
  });
});

describe('write slots (12)', () => {
  it('counts streamed writes and the write-behind against one cap', async () => {
    const queue = new WriteQueue(2, 0);
    const first = await queue.acquireSlot();
    const second = await queue.acquireSlot();
    const s = await harness();
    const content = Buffer.from('write-behind');
    const reservation = s.staging.reserve(hex(sha1(content)))!;
    void queue.enqueue({
      runId: s.run.id,
      token: { detached: false },
      store: s.staging,
      reservation,
      buf: content,
      lease: null,
      space: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // both slots are held by streams: the buffered write waits
    expect(s.staging.hasBlob(hex(sha1(content)))).toBe(false);
    expect(queue.pending(s.run.id)).toBe(1);
    first.release();
    await queue.drain(s.run.id, { dropQueued: false, capMs: Infinity });
    expect(s.staging.hasBlob(hex(sha1(content)))).toBe(true);
    expect(queue.peakInFlight).toBe(2);
    second.release();
  });
});

describe('ReadStatsTracker', () => {
  const partRow = { id: 'p1', fileName: 'takeout-001.zip', size: 1000, segment: 1, partNumber: 1 };

  it('never moves the covered position of a zip continuation back (it re-reads the directory first)', () => {
    const stats = new ReadStatsTracker({});
    const ps = stats.part(partRow);
    const first = newReadMeter();
    stats.beginPass(ps, first, true);
    first.position = 600;
    stats.endPass(ps);
    expect(stats.covered()).toBe(600);

    const next = newReadMeter();
    stats.beginPass(ps, next, false);
    // directory read at 0, then the walk starts at the resume entry, below the old position
    expect(stats.covered()).toBe(600);
    next.position = 450;
    expect(stats.covered()).toBe(600);
    next.position = 800;
    expect(stats.covered()).toBe(800);
  });

  it('counts live fetch bytes up to the plan and takes the real bytes into the total when a fetch ends', () => {
    const stats = new ReadStatsTracker({});
    const ps = stats.part(partRow);
    stats.stats.fetchBytesTotal = 500;
    const meter = newReadMeter();
    const pass = stats.beginFetch(ps, meter, 500);
    meter.bytesRead = 200;
    stats.syncFetch();
    expect([stats.stats.fetchBytesRead, stats.stats.fetchBytesTotal, ps.fetchBytesRead]).toEqual([200, 500, 200]);
    // the zip directory and readahead past the last entry: never more than the plan while live
    meter.bytesRead = 650;
    stats.syncFetch();
    expect(stats.stats.fetchBytesRead).toBe(500);
    stats.endFetch(pass);
    expect([stats.stats.fetchBytesRead, stats.stats.fetchBytesTotal, ps.fetchBytesRead]).toEqual([650, 650, 650]);
  });

  it('estimates the fetch time from the fetch bytes of the last two minutes', () => {
    const stats = new ReadStatsTracker({});
    const ps = stats.part(partRow);
    stats.stats.fetchBytesTotal = 10_000;
    const meter = newReadMeter();
    stats.beginFetch(ps, meter, 10_000);
    expect(stats.fetchEta(0)).toBeNull();
    meter.bytesRead = 1000;
    expect(stats.fetchEta(10_000)).toBe(90);
  });
});

const checksumOf = (n: number) => Buffer.alloc(20, n);

describe('recountReadStats', () => {
  it('replaces the drifted live counters of the parts this run read with the committed catalog', () => {
    // live counters after a restart and a cancel: entries counted twice, others never counted
    const stats = new ReadStatsTracker({
      filesFound: 9,
      mediaFound: 7,
      jsonFound: 1,
      serverDuplicatesSkipped: 0,
      localDuplicatesSkipped: 3,
      stagedFiles: 2,
      stagedBytes: 20,
      wastedWriteFiles: 1,
      fetchBytesRead: 77,
      parts: {
        p1: { partId: 'p1', fileName: 'a.tgz', size: 100, passes: 2, entries: 9, media: 7, staged: 2, duplicates: 3 },
        p2: { partId: 'p2', fileName: 'b.tgz', size: 100, passes: 0, status: 'cached', entries: 0 },
      },
    }).stats;
    const c = checksumOf;
    const entries = [
      { partId: 'p1', kind: 'media', size: 10, checksum: c(1), readError: null }, // staged
      { partId: 'p1', kind: 'json', size: 1, checksum: null, readError: null },
      { partId: 'p1', kind: 'media', size: 11, checksum: c(2), readError: null }, // on the server
      { partId: 'p1', kind: 'media', size: 10, checksum: c(1), readError: null }, // same content again
      { partId: 'p1', kind: 'media', size: 12, checksum: c(3), readError: null }, // hashed only, no blob
      { partId: 'p1', kind: 'other', size: 5, checksum: null, readError: 'CRC-32 mismatch' },
      { partId: 'p2', kind: 'media', size: 13, checksum: c(4), readError: null }, // a part this run did not read
    ];
    recountReadStats(stats, entries, {
      onServer: (checksum) => checksum.equals(c(2)),
      hasBlob: (key) => key === hex(c(1)) || key === hex(c(4)),
    });

    expect(stats.filesFound).toBe(6);
    expect(stats.mediaFound).toBe(4);
    expect(stats.jsonFound).toBe(1);
    expect(stats.serverDuplicatesSkipped).toBe(1);
    expect(stats.localDuplicatesSkipped).toBe(1);
    expect([stats.stagedFiles, stats.stagedBytes]).toEqual([1, 10]);
    const p1 = stats.parts.p1;
    expect([p1.entries, p1.media, p1.entryErrors, p1.staged, p1.stagedBytes, p1.duplicates, p1.deferred]).toEqual([
      6, 4, 1, 1, 10, 2, 1,
    ]);
    // the parts this run did not read, and the I/O figures, keep what was measured
    expect([stats.parts.p2.entries, stats.parts.p2.staged]).toEqual([0, 0]);
    expect([stats.wastedWriteFiles, stats.fetchBytesRead, p1.passes]).toEqual([1, 77, 2]);
  });
});

describe('SpaceBudget', () => {
  it('never waits for a statfs that does not answer, and never starts a second one behind it', async () => {
    let calls = 0;
    const budget = new SpaceBudget({
      quotaLimit: null,
      quotaUsage: 0,
      reserve: 0,
      statfs: () => (calls++ === 0 ? Promise.resolve(1000) : new Promise<number>(() => {})),
    });
    await budget.refresh(50);
    expect(budget.available).toBe(1000);
    budget.refreshInBackground();
    budget.refreshInBackground();
    await budget.refresh(20);
    expect(calls).toBe(2);
    expect(budget.available).toBe(1000);
  });
});
