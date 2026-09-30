import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core';
import { TakeoutLargerVersionAction } from 'src/dtos/takeout.dto';
import { JobName, TakeoutCatalogStatus, TakeoutRunFileAction, TakeoutRunFileStatus, TakeoutRunStatus } from 'src/enum';
import { runStagingDir, STAGING_TTL_MS, stagingRoot } from 'src/services/takeout-staging';
import { TakeoutService } from 'src/services/takeout.service';
import { countersFromRows } from 'src/takeout';
import { authStub } from 'test/fixtures/auth.stub';
import { TakeoutMemoryRepository } from 'test/fixtures/takeout-memory.repository';
import { newTestService, ServiceMocks } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

const userId = authStub.admin.user.id;
const auth = authStub.admin;
const HOUR = 3_600_000;

// a run file row that points at a file under upload/
const targetRow = (runId: string, target: string, over: Record<string, unknown> = {}) => ({
  runId,
  seq: 0,
  takeoutPath: 'a',
  size: 7,
  checksum: Buffer.alloc(20),
  fileKind: 'image',
  action: TakeoutRunFileAction.Upload,
  status: TakeoutRunFileStatus.Error,
  targetPath: target,
  newAssetId: randomUUID(),
  entrySeq: 0,
  ...over,
});

/** exports whose analysis the service queued, one entry per job */
const analysed = (mocks: ServiceMocks) =>
  mocks.job.queue.mock.calls
    .filter((call) => (call[0] as any).name === JobName.TakeoutAnalyzeExport)
    .map((call) => (call[0] as any).data.exportId);

async function writeUploadFile(mediaLocation: string, name: string) {
  const target = join(mediaLocation, 'upload', userId, name);
  await mkdir(join(mediaLocation, 'upload', userId), { recursive: true });
  await writeFile(target, 'content');
  return target;
}

describe(TakeoutService.name, () => {
  let sut: TakeoutService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TakeoutService));
  });

  describe('getSettings', () => {
    it('returns the defaults when nothing is saved', async () => {
      mocks.takeout.getSettings.mockResolvedValue(undefined as any);
      const settings = await sut.getSettings(authStub.admin);
      expect(settings.homeTimeZone).toBe('America/New_York');
      expect(settings.rawJpg).toBe('StackCoverRaw');
    });

    it('merges saved settings over the defaults', async () => {
      mocks.takeout.getSettings.mockResolvedValue({ settings: { sessionTag: false } } as any);
      const settings = await sut.getSettings(authStub.admin);
      expect(settings.sessionTag).toBe(false);
      expect(settings.peopleTags).toBe(true);
    });
  });

  describe('updateSettings', () => {
    it('rejects an invalid time zone', async () => {
      await expect(sut.updateSettings(authStub.admin, { homeTimeZone: 'Not/AZone' } as any)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.takeout.upsertSettings).not.toHaveBeenCalled();
    });

    it('saves valid settings merged over what is stored', async () => {
      mocks.takeout.getSettings.mockResolvedValue({ settings: {} } as any);
      mocks.takeout.upsertSettings.mockResolvedValue(undefined as any);
      const result = await sut.updateSettings(authStub.admin, { sessionTag: false } as any);
      expect(mocks.takeout.upsertSettings).toHaveBeenCalledWith(userId, { sessionTag: false });
      expect(result.sessionTag).toBe(false);
    });
  });

  describe('resolveLargerVersion', () => {
    it('409s when the smaller version is already gone', async () => {
      mocks.takeout.getLargerVersion.mockResolvedValue({ id: 'lv1', userId, smallerAssetId: null } as any);
      await expect(
        sut.resolveLargerVersion(authStub.admin, 'lv1', { action: TakeoutLargerVersionAction.DeleteSmaller }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('trashes the smaller asset with the same code path as delete', async () => {
      mocks.takeout.getLargerVersion
        .mockResolvedValueOnce({ id: 'lv1', userId, largerAssetId: 'L', smallerAssetId: 'S' } as any)
        .mockResolvedValue({
          id: 'lv1',
          userId,
          largerAssetId: 'L',
          smallerAssetId: 'S',
          status: 'deletedSmaller',
          runId: null,
          createdAt: new Date(),
          resolvedAt: new Date(),
        } as any);
      mocks.asset.getByIds.mockImplementation((ids: string[]) =>
        Promise.resolve(ids.map((id) => ({ id, ownerId: userId, exifInfo: {} }) as any)),
      );
      mocks.asset.updateAll.mockResolvedValue(undefined as any);
      mocks.event.emit.mockResolvedValue(undefined as any);
      const mapSpy = vitest.spyOn(sut as any, 'mapLargerVersion').mockResolvedValue({ id: 'lv1' } as any);

      await sut.resolveLargerVersion(authStub.admin, 'lv1', { action: TakeoutLargerVersionAction.DeleteSmaller });

      expect(mocks.asset.updateAll).toHaveBeenCalledWith(['S'], expect.objectContaining({ status: expect.anything() }));
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetTrashAll', { assetIds: ['S'], userId });
      expect(mocks.takeout.updateLargerVersion).toHaveBeenCalledWith(
        'lv1',
        expect.objectContaining({ status: 'deletedSmaller' }),
      );
      mapSpy.mockRestore();
    });
  });
});

// ---------- runs, sync, sweep and boot on the in-memory repository (single-pass design 17.2.4) ----------

describe(`${TakeoutService.name} (single-pass)`, () => {
  let sut: TakeoutService;
  let mocks: ServiceMocks;
  let repo: TakeoutMemoryRepository;
  let dir: string;
  let folder: string;
  let exportId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'takeout-service-'));
    repo = new TakeoutMemoryRepository();
    ({ sut, mocks } = newTestService(TakeoutService, { takeout: repo as any }));
    StorageCore.setMediaLocation(dir);
    repo.addFolder(userId, 'me');
    folder = join(dir, 'takeouts', 'me');
    await mkdir(folder, { recursive: true });
    exportId = repo.addExport({ userId }).id;
    const assets = repo.assetRepository();
    mocks.asset.getByIds.mockImplementation(assets.getByIds as any);
    mocks.job.queue.mockResolvedValue();
    mocks.job.queueAll.mockResolvedValue();
    mocks.job.removeJob.mockResolvedValue();
    mocks.storage.checkDiskUsage.mockResolvedValue({ available: 1e13, free: 1e13, total: 1e13 });
    mocks.user.getList.mockResolvedValue([{ id: userId, name: 'me', storageLabel: null, deletedAt: null }] as any);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const oldCtime = new Date(Date.now() - HOUR);
  const addPart = (over: Record<string, unknown> = {}) =>
    repo.addPart({
      exportId,
      userId,
      fileName: `takeout-20260914T211500Z-1-00${repo.parts.length + 1}.tgz`,
      partNumber: repo.parts.length + 1,
      size: 100,
      prevSyncSize: 100,
      ctime: oldCtime,
      ...over,
    });

  async function writePart(name: string, bytes = 'x'.repeat(100)) {
    const path = join(folder, name);
    await writeFile(path, bytes);
    const old = new Date(Date.now() - HOUR);
    await utimes(path, old, old);
    return path;
  }

  async function stagingDir(name: string, ageMs = 2 * HOUR) {
    const path = join(stagingRoot(folder), name);
    await mkdir(path, { recursive: true });
    const when = new Date(Date.now() - ageMs);
    await utimes(path, when, when);
    return path;
  }

  async function names() {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const listed = await readdir(stagingRoot(folder));
    return listed.filter((name) => !name.startsWith('.trash-')).toSorted();
  }

  describe('folder sync', () => {
    it('never queues a scan and resets the catalog of a part whose file changed', async () => {
      const path = await writePart('takeout-20260914T211500Z-1-001.tgz');
      await writePart('takeout-20260914T211500Z-1-002.tgz');
      await sut.syncUserFolder(userId);
      expect(repo.parts).toHaveLength(2);
      const part = repo.parts.find((p) => p.fileName.endsWith('001.tgz'))!;
      const st = await stat(path);
      Object.assign(part, {
        catalogStatus: TakeoutCatalogStatus.Complete,
        catalogVersion: 2,
        catalogSize: st.size,
        catalogMtime: st.mtime,
      });
      repo.entries.push({ id: 1, exportId: part.exportId, partId: part.id, seq: 0, path: 'a', size: 1, kind: 'media' });

      // the same file again: nothing changes
      await sut.syncUserFolder(userId);
      expect(part.catalogStatus).toBe(TakeoutCatalogStatus.Complete);

      await appendFile(path, 'more');
      await sut.syncUserFolder(userId);
      expect(part.catalogStatus).toBe(TakeoutCatalogStatus.None);
      expect(repo.entries).toEqual([]);
      const queued = mocks.job.queue.mock.calls.map((call) => (call[0] as any).name);
      expect(queued).not.toContain(JobName.TakeoutScanPart);
      expect(queued).toContain(JobName.TakeoutAnalyzeExport);
    });

    it('never touches the parts of an export with a running run', async () => {
      const path = await writePart('takeout-20260914T211500Z-1-001.tgz');
      await sut.syncUserFolder(userId);
      const part = repo.parts[0];
      Object.assign(part, { catalogStatus: TakeoutCatalogStatus.Reading, catalogVersion: 2 });
      repo.addRun({ userId, exportId: part.exportId, status: TakeoutRunStatus.Reading });
      await appendFile(path, 'more');
      await sut.syncUserFolder(userId);
      expect(part.catalogStatus).toBe(TakeoutCatalogStatus.Reading);
      expect(part.size).toBe(100);
    });

    it('analyses again once a part that was still being copied is stable', async () => {
      vitest.useFakeTimers({ toFake: ['Date'] });
      try {
        // a sync saw the file while it was being written (fresh ctime): the analysis said part_unstable
        await writePart('takeout-20260914T211500Z-1-001.tgz');
        await sut.syncUserFolder(userId);
        const exp = repo.exports.find((e) => e.id === repo.parts[0].exportId)!;
        exp.analysis = { reasons: ['part_unstable'] };
        const analyses = () =>
          mocks.job.queue.mock.calls.filter((call) => (call[0] as any).name === JobName.TakeoutAnalyzeExport).length;
        const first = analyses();

        // nothing changed on disk and the part is still fresh: no new analysis
        await sut.syncUserFolder(userId);
        expect(analyses()).toBe(first);

        // time passes: the part is stable now, the file itself did not change
        vitest.setSystemTime(Date.now() + 60_000);
        await sut.syncUserFolder(userId);
        expect(analyses()).toBe(first + 1);

        // once the analysis saw the stable part, syncs stay quiet again
        exp.analysis = { reasons: [] };
        await sut.syncUserFolder(userId);
        expect(analyses()).toBe(first + 1);
      } finally {
        vitest.useRealTimers();
      }
    });

    it('marks a vanished part missing and forgets its rows', async () => {
      const path = await writePart('takeout-20260914T211500Z-1-001.tgz');
      await sut.syncUserFolder(userId);
      repo.entries.push({ id: 1, exportId: repo.parts[0].exportId, partId: repo.parts[0].id, seq: 0 });
      await rm(path);
      await sut.syncUserFolder(userId);
      expect(repo.parts[0].isMissing).toBe(true);
      expect(repo.entries).toEqual([]);
    });

    describe('an index archive an older grouping chained onto another export (family folder)', () => {
      const aIndex = 'takeout-20260928T015748Z-001.tgz';
      const bIndex = 'takeout-20260928T025618Z-001.tgz';
      const aMedia = Array.from(
        { length: 15 },
        (_, i) => `takeout-20260928T015749Z-1-${String(i + 1).padStart(3, '0')}.tgz`,
      );
      const bMedia = ['takeout-20260928T025618Z-1-001.tgz', 'takeout-20260928T025618Z-1-002.tgz'];

      // What the old grouping stored: export A holds its 15 parts, its own index and, as media part 1 without a
      // segment, the index of export B (another Google account). B holds its 2 parts and no index.
      async function seedBrokenFamily() {
        repo.exports = [];
        const a = repo.addExport({
          userId,
          exportKey: '20260928T015749Z-1',
          exportedAt: new Date('2026-09-28T01:57:49Z'),
          indexFileName: aIndex,
          accountEmail: 'a@example.com',
          indexFileCount: 89_928,
          analysis: { indexFiles: ['Takeout/Google Photos/a.jpg'] },
          createdAt: new Date('2026-09-28T03:00:00Z'),
        });
        const b = repo.addExport({
          userId,
          exportKey: '20260928T025618Z-1',
          exportedAt: new Date('2026-09-28T02:56:18Z'),
          createdAt: new Date('2026-09-28T03:00:01Z'),
        });
        const seed = async (exportRow: any, name: string, over: Record<string, unknown>) => {
          const info = await stat(await writePart(name));
          return repo.addPart({
            exportId: exportRow.id,
            userId,
            fileName: name,
            size: info.size,
            prevSyncSize: info.size,
            mtime: info.mtime,
            ctime: info.ctime,
            catalogStatus: TakeoutCatalogStatus.Complete,
            catalogVersion: 2,
            catalogSize: info.size,
            catalogMtime: info.mtime,
            entryCount: 1,
            ...over,
          });
        };
        for (const [i, name] of aMedia.entries()) {
          await seed(a, name, { timestamp: '20260928T015749Z', segment: 1, partNumber: i + 1 });
        }
        await seed(a, aIndex, {
          timestamp: '20260928T015748Z',
          segment: null,
          partNumber: 1,
          isIndex: true,
          catalogStatus: TakeoutCatalogStatus.None,
        });
        const stray = await seed(a, bIndex, { timestamp: '20260928T025618Z', segment: null, partNumber: 1 });
        repo.entries.push({
          id: 1,
          exportId: a.id,
          partId: stray.id,
          seq: 0,
          path: 'Takeout/archive_browser.html',
          kind: 'other',
        });
        for (const [i, name] of bMedia.entries()) {
          await seed(b, name, { timestamp: '20260928T025618Z', segment: 1, partNumber: i + 1 });
        }
        return { a, b, stray };
      }

      it('moves it to its own export, and a second sync changes nothing', async () => {
        const { a, b, stray } = await seedBrokenFamily();
        await sut.syncUserFolder(userId);

        expect(repo.exports).toHaveLength(2);
        expect(stray).toMatchObject({
          exportId: b.id,
          isIndex: true,
          segment: null,
          partNumber: 1,
          catalogStatus: TakeoutCatalogStatus.None,
          entryCount: null,
        });
        expect(repo.entries).toEqual([]);
        expect(b.indexFileName).toBe(bIndex);
        const partsOf = (exportRow: any) =>
          repo.parts.filter((p) => p.exportId === exportRow.id && !p.isIndex).map((p) => p.fileName);
        const indexOf = (exportRow: any) =>
          repo.parts.filter((p) => p.exportId === exportRow.id && p.isIndex).map((p) => p.fileName);
        expect(partsOf(a)).toEqual(aMedia);
        expect(indexOf(a)).toEqual([aIndex]);
        expect(partsOf(b)).toEqual(bMedia);
        expect(indexOf(b)).toEqual([bIndex]);
        // A keeps its own index and what came from it; both are analysed again
        expect(a).toMatchObject({ indexFileName: aIndex, accountEmail: 'a@example.com', indexFileCount: 89_928 });
        expect(a.analysis.indexFiles).toEqual(['Takeout/Google Photos/a.jpg']);
        expect(new Set(analysed(mocks))).toEqual(new Set([a.id, b.id]));

        const parts = structuredClone(repo.parts);
        const exports = structuredClone(repo.exports);
        await sut.syncUserFolder(userId);
        expect(repo.parts).toEqual(parts);
        expect(repo.exports).toEqual(exports);
        expect(analysed(mocks)).toHaveLength(2);
      });

      it('makes the export that loses an index forget what came from it', async () => {
        // the stray index was even taken as A's index: A forgets it and takes its own again
        const { a, b, stray } = await seedBrokenFamily();
        Object.assign(a, {
          indexFileName: bIndex,
          accountEmail: 'b@example.com',
          googleJobId: 'job-b',
          indexTotalSize: '12 GB',
          indexFileCount: 1200,
          indexCreatedText: 'created b',
          analysis: {
            indexFiles: ['Takeout/Google Photos/b.jpg'],
            indexSource: { fileName: bIndex, size: 100, mtime: '2026-09-28T03:00:00.000Z' },
            indexTotalBytes: 12e9,
            lastRead: { runId: 'r', indexMissingFiles: { count: 3, sample: ['x', 'y', 'z'] }, notInIndex: 2 },
          },
        });
        stray.isIndex = true;
        await sut.syncUserFolder(userId);

        expect(stray).toMatchObject({ exportId: b.id, isIndex: true });
        expect(b.indexFileName).toBe(bIndex);
        expect(a).toMatchObject({
          indexFileName: aIndex,
          accountEmail: null,
          googleJobId: null,
          indexTotalSize: null,
          indexFileCount: null,
          indexCreatedText: null,
        });
        expect(a.analysis).toEqual({ lastRead: { runId: 'r', indexMissingFiles: null, notInIndex: 0 } });
        expect(new Set(analysed(mocks))).toEqual(new Set([a.id, b.id]));
      });

      it('leaves it where it is while that export is being imported', async () => {
        const { a, b, stray } = await seedBrokenFamily();
        repo.addRun({ userId, exportId: a.id, status: TakeoutRunStatus.Reading });
        await sut.syncUserFolder(userId);
        expect(stray).toMatchObject({ exportId: a.id, isIndex: false, isMissing: false });
        expect(b.indexFileName).toBeNull();
        expect(repo.entries).toHaveLength(1);
      });
    });
  });

  describe('createRun', () => {
    it('409s while another run is active', async () => {
      addPart();
      repo.addRun({ userId, exportId, status: TakeoutRunStatus.Importing });
      await expect(sut.createRun(auth, exportId, { importAnyway: false })).rejects.toThrow(
        'An import is already running',
      );
    });

    it('rejects an incomplete export unless importAnyway is set', async () => {
      repo.exports[0].completeness = 'uncertain';
      await expect(sut.createRun(auth, exportId, { importAnyway: false })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s an export that belongs to another user', async () => {
      repo.exports[0].userId = 'someone-else';
      await expect(sut.createRun(auth, exportId, { importAnyway: false })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('409s while a part is still being copied', async () => {
      addPart({ ctime: new Date() });
      await expect(sut.createRun(auth, exportId, { importAnyway: false })).rejects.toThrow(
        'A part is still being copied',
      );
    });

    it('409s when the previous run has half-imported files', async () => {
      addPart();
      const old = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Failed, hasStaging: true });
      await repo.insertRunFiles([
        {
          runId: old.id,
          seq: 0,
          takeoutPath: 'a',
          size: 1,
          fileKind: 'image',
          action: 'upload',
          status: TakeoutRunFileStatus.Created,
        },
      ]);
      await expect(sut.createRun(auth, exportId, { importAnyway: false })).rejects.toThrow(/half imported/);
    });

    it('adopts the staging of the previous failed run', async () => {
      addPart();
      const old = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Failed, hasStaging: true });
      await repo.insertRunFiles([
        {
          runId: old.id,
          seq: 0,
          takeoutPath: 'a',
          size: 1,
          fileKind: 'image',
          action: 'upload',
          status: TakeoutRunFileStatus.Planned,
        },
      ]);
      const created = await sut.createRun(auth, exportId, { importAnyway: false });
      const stored = repo.runs.find((r) => r.id === old.id)!;
      expect(stored.status).toBe(TakeoutRunStatus.Cancelled);
      expect(stored.supersededBy).toBe(created.id);
      expect(stored.hasStaging).toBe(false);
      expect(repo.runFiles[0]).toMatchObject({ status: TakeoutRunFileStatus.Skipped, reason: 'superseded' });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.TakeoutRun,
        data: { runId: created.id, attempt: 0 },
      });
    });

    it('lets exactly one of two concurrent requests start a run (F19)', async () => {
      addPart();
      const old = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Cancelled });
      const results = await Promise.allSettled([
        sut.createRun(auth, exportId, { importAnyway: false }),
        sut.resumeRun(auth, old.id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(repo.runs.filter((r) => r.status === TakeoutRunStatus.Queued)).toHaveLength(1);
    });

    it('stores {user} as the Google account name and {email} as the whole account email, lowercased', async () => {
      // family: aeroverra@g.minecraft.technology and Aeroverra@Minecraft.Technology both tagged "aeroverra"
      addPart();
      repo.exports[0].accountEmail = 'Aeroverra@Minecraft.Technology';
      const created = await sut.createRun(auth, exportId, { importAnyway: false });
      expect(repo.runs.find((r) => r.id === created.id)!.templateVars).toMatchObject({
        date: '2026-09-14',
        user: 'Aeroverra',
        email: 'aeroverra@minecraft.technology',
      });
    });

    it('stores the Immich user name for {user} and {email} when the export has no account email', async () => {
      addPart();
      repo.exports[0].accountEmail = null;
      const created = await sut.createRun(auth, exportId, { importAnyway: false });
      expect(repo.runs.find((r) => r.id === created.id)!.templateVars).toMatchObject({
        user: auth.user.name,
        email: auth.user.name,
      });
    });

    it('only needs the free-space reserve, not the export size (F20)', async () => {
      addPart({ size: 900e9, prevSyncSize: 900e9 });
      mocks.storage.checkDiskUsage.mockResolvedValue({ available: 6 * 1024 ** 3, free: 0, total: 0 });
      await expect(sut.createRun(auth, exportId, { importAnyway: false })).resolves.toBeTruthy();
      mocks.storage.checkDiskUsage.mockResolvedValue({ available: 1024 ** 3, free: 0, total: 0 });
      repo.runs = [];
      await expect(sut.createRun(auth, exportId, { importAnyway: false })).rejects.toThrow('Not enough free space');
    });
  });

  describe('resumeRun', () => {
    it('plans the rows a cancel skipped again (F19)', async () => {
      const run = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Cancelled });
      await repo.insertRunFiles([
        {
          runId: run.id,
          seq: 0,
          takeoutPath: 'a',
          size: 1,
          fileKind: 'image',
          action: TakeoutRunFileAction.Upload,
          status: TakeoutRunFileStatus.Skipped,
          reason: 'cancelled',
        },
        {
          runId: run.id,
          seq: 1,
          takeoutPath: 'b',
          size: 1,
          fileKind: 'image',
          action: TakeoutRunFileAction.Useless,
          status: TakeoutRunFileStatus.Skipped,
          reason: 'useless',
        },
      ]);
      const resumed = await sut.resumeRun(auth, run.id);
      expect(resumed.status).toBe(TakeoutRunStatus.Queued);
      expect(repo.runFiles.map((f) => f.status)).toEqual([TakeoutRunFileStatus.Planned, TakeoutRunFileStatus.Skipped]);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.TakeoutRun, data: { runId: run.id, attempt: 1 } });
    });

    it("keeps the planner's reason of the rows a cancel skipped, and rebuilds the one an old cancel overwrote", async () => {
      const run = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Cancelled });
      const row = (seq: number, over: Record<string, unknown>) => ({
        runId: run.id,
        seq,
        takeoutPath: `p${seq}`,
        size: 1,
        fileKind: 'image',
        status: TakeoutRunFileStatus.Skipped,
        ...over,
      });
      await repo.insertRunFiles([
        row(0, {
          action: TakeoutRunFileAction.Upload,
          reason: 'server had a smaller version',
          smallerAssetId: randomUUID(),
          fallbacks: ['cancelled'],
        }),
        row(1, {
          action: TakeoutRunFileAction.ServerDuplicate,
          reason: 'already on the server (in trash)',
          fallbacks: ['zoneAssumed', 'cancelled'],
        }),
        // skipped 'cancelled' by the importer before single-pass
        row(2, { action: TakeoutRunFileAction.Upload, reason: 'cancelled', smallerAssetId: randomUUID() }),
        row(3, { action: TakeoutRunFileAction.BetterOnServer, reason: 'cancelled' }),
        row(4, { action: TakeoutRunFileAction.Upload, reason: 'cancelled' }),
      ]);
      await sut.resumeRun(auth, run.id);
      expect(repo.runFiles.map((f) => [f.status, f.reason, f.fallbacks])).toEqual([
        [TakeoutRunFileStatus.Planned, 'server had a smaller version', []],
        [TakeoutRunFileStatus.Planned, 'already on the server (in trash)', ['zoneAssumed']],
        [TakeoutRunFileStatus.Planned, 'server had a smaller version', []],
        [TakeoutRunFileStatus.Planned, 'the server already has a larger version', []],
        [TakeoutRunFileStatus.Planned, null, []],
      ]);
      const counters = countersFromRows(await repo.getCounterRows(run.id), { total: 0, done: 0 });
      expect(counters.result.largerUploaded).toBe(2);
    });

    it('refuses a superseded run', async () => {
      const run = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Cancelled, supersededBy: randomUUID() });
      await expect(sut.resumeRun(auth, run.id)).rejects.toThrow('A newer import took over this one');
    });

    it('checks only the free-space reserve', async () => {
      const run = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Failed });
      mocks.storage.checkDiskUsage.mockResolvedValue({ available: 1024 ** 3, free: 0, total: 0 });
      await expect(sut.resumeRun(auth, run.id)).rejects.toThrow('Not enough free space');
      mocks.storage.checkDiskUsage.mockResolvedValue({ available: 6 * 1024 ** 3, free: 0, total: 0 });
      await expect(sut.resumeRun(auth, run.id)).resolves.toMatchObject({ status: TakeoutRunStatus.Queued });
    });
  });

  describe('cancelRun', () => {
    it('cleans up a queued run inline', async () => {
      const run = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Queued });
      const result = await sut.cancelRun(auth, run.id);
      expect(result.status).toBe(TakeoutRunStatus.Cancelled);
    });

    it('asks a live running run to stop and keeps its staging', async () => {
      const run = repo.addRun({
        userId,
        exportId,
        status: TakeoutRunStatus.Importing,
        heartbeatAt: new Date(),
        hasStaging: true,
      });
      await mkdir(runStagingDir(folder, run.id), { recursive: true });
      const result = await sut.cancelRun(auth, run.id);
      expect(result.status).toBe(TakeoutRunStatus.Cancelling);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('TakeoutRunCancel', { runId: run.id });
      expect(await readdir(stagingRoot(folder))).toEqual([run.id]);
    });

    it('never cleans up a queued run whose live job holds it: it asks the job to stop (I10)', async () => {
      // a resumed run stays queued while its job repairs and re-checks, with the lease held
      const run = repo.addRun({
        userId,
        exportId,
        status: TakeoutRunStatus.Queued,
        leaseToken: 'job-token',
        heartbeatAt: new Date(),
        hasStaging: true,
      });
      const target = join(dir, 'upload', userId, 'moved.jpg');
      await mkdir(join(dir, 'upload', userId), { recursive: true });
      await writeFile(target, 'the only copy');
      await repo.insertRunFiles([
        {
          runId: run.id,
          seq: 0,
          takeoutPath: 'a',
          size: 13,
          checksum: Buffer.alloc(20, 1),
          fileKind: 'image',
          action: TakeoutRunFileAction.Upload,
          status: TakeoutRunFileStatus.Written,
          targetPath: target,
          newAssetId: randomUUID(),
          entrySeq: 0,
        },
      ]);
      const result = await sut.cancelRun(auth, run.id);
      expect(result.status).toBe(TakeoutRunStatus.Cancelling);
      expect(repo.runs[0].leaseToken).toBe('job-token');
      expect(repo.runFiles[0]).toMatchObject({ status: TakeoutRunFileStatus.Written, targetPath: target });
      expect(await stat(target)).toBeTruthy();
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('TakeoutRunCancel', { runId: run.id });
    });

    it('takes over the run of a dead job (heartbeat older than 60 s) and cleans it up', async () => {
      const run = repo.addRun({
        userId,
        exportId,
        status: TakeoutRunStatus.Importing,
        leaseToken: 'dead-job',
        heartbeatAt: new Date(Date.now() - 2 * 60_000),
      });
      const result = await sut.cancelRun(auth, run.id);
      expect(result.status).toBe(TakeoutRunStatus.Cancelled);
      expect(repo.runs[0].leaseToken).toBeNull();
    });

    it('rejects cancelling a completed run', async () => {
      const run = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Completed });
      await expect(sut.cancelRun(auth, run.id)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('discards the staging of a failed run', async () => {
      const run = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Failed, hasStaging: true });
      await mkdir(join(runStagingDir(folder, run.id), 'ab'), { recursive: true });
      await writeFile(join(runStagingDir(folder, run.id), 'ab', 'blob'), 'x');
      const result = await sut.cancelRun(auth, run.id);
      expect(result.status).toBe(TakeoutRunStatus.Cancelled);
      expect(result.hasStaging).toBe(false);
      const names = await readdir(stagingRoot(folder));
      expect(names).not.toContain(run.id);
    });

    it('discards the staging of a cancelled run that still holds some, and is a no-op without', async () => {
      const run = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Cancelled, hasStaging: true });
      await sut.cancelRun(auth, run.id);
      expect(repo.runs[0].hasStaging).toBe(false);
      const again = await sut.cancelRun(auth, run.id);
      expect(again.status).toBe(TakeoutRunStatus.Cancelled);
    });
  });

  describe('pauseRun', () => {
    it('pauses a running run, notes when and from which status, and tells the job', async () => {
      const run = repo.addRun({
        userId,
        exportId,
        status: TakeoutRunStatus.Reading,
        leaseToken: 'job',
        heartbeatAt: new Date(),
        readStats: { stagedFiles: 3 },
      });
      const result = await sut.pauseRun(auth, run.id);
      expect(result).toMatchObject({
        status: TakeoutRunStatus.Paused,
        pausedFrom: TakeoutRunStatus.Reading,
        pausedAt: expect.any(String),
      });
      expect(result.readStats.stagedFiles).toBe(3);
      // the job keeps the run: its lease is untouched
      expect(repo.runs[0].leaseToken).toBe('job');
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('TakeoutRunPause', { runId: run.id });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith(
        'on_takeout_run',
        userId,
        expect.objectContaining({ status: TakeoutRunStatus.Paused }),
      );
      // pausing again changes nothing
      const again = await sut.pauseRun(auth, run.id);
      expect(again.pausedAt).toBe(result.pausedAt);
    });

    it('pauses a queued run too, and refuses a run that is not running', async () => {
      const queued = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Queued });
      const paused = await sut.pauseRun(auth, queued.id);
      expect(paused.status).toBe(TakeoutRunStatus.Paused);
      for (const status of [
        TakeoutRunStatus.Completed,
        TakeoutRunStatus.Failed,
        TakeoutRunStatus.Cancelled,
        TakeoutRunStatus.Cancelling,
      ]) {
        const run = repo.addRun({ userId, exportId, status });
        await expect(sut.pauseRun(auth, run.id)).rejects.toBeInstanceOf(BadRequestException);
        expect(repo.runs.find((r) => r.id === run.id)!.status).toBe(status);
      }
    });

    it('blocks a new run while one is paused', async () => {
      repo.addRun({ userId, exportId, status: TakeoutRunStatus.Paused });
      await expect(sut.createRun(auth, exportId, { importAnyway: false })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  const pausedRun = (over: Record<string, unknown> = {}) =>
    repo.addRun({
      userId,
      exportId,
      status: TakeoutRunStatus.Paused,
      attempt: 2,
      readStats: {
        pausedAt: new Date(Date.now() - 60_000).toISOString(),
        pausedFrom: TakeoutRunStatus.Importing,
        parts: { p1: { partId: 'p1', fileName: 'a.tgz', size: 10, status: 'paused', pausedMs: 0 } },
      },
      ...over,
    });

  describe('resumeRun of a paused run', () => {
    it('lets the live job continue where it waits: back to the status it was paused in', async () => {
      const run = pausedRun({ leaseToken: 'job', heartbeatAt: new Date() });
      const result = await sut.resumeRun(auth, run.id);
      expect(result).toMatchObject({ status: TakeoutRunStatus.Importing, pausedAt: null, pausedFrom: null });
      expect(repo.runs[0]).toMatchObject({ leaseToken: 'job', attempt: 2 });
      expect(repo.runs[0].readStats.pausedAt).toBeUndefined();
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('TakeoutRunPause', { runId: run.id });
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('queues a run whose job is gone (a restart) again with the next attempt, counting the pause', async () => {
      const run = pausedRun({ leaseToken: null, heartbeatAt: null });
      const result = await sut.resumeRun(auth, run.id);
      expect(result.status).toBe(TakeoutRunStatus.Queued);
      expect(repo.runs[0].attempt).toBe(3);
      expect(mocks.job.removeJob).toHaveBeenCalledWith(JobName.TakeoutRun, `${run.id}/2`);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.TakeoutRun, data: { runId: run.id, attempt: 3 } });
      const stats = repo.runs[0].readStats;
      expect(stats.pausedAt).toBeUndefined();
      expect(stats.pausedMs).toBeGreaterThanOrEqual(60_000);
      expect(stats.parts.p1).toMatchObject({ status: 'pending' });
      expect(stats.parts.p1.pausedMs).toBeGreaterThanOrEqual(60_000);
    });

    it('treats a lease whose heartbeat is older than 60 s as gone', async () => {
      const run = pausedRun({ leaseToken: 'dead', heartbeatAt: new Date(Date.now() - 2 * 60_000) });
      const resumed = await sut.resumeRun(auth, run.id);
      expect(resumed.status).toBe(TakeoutRunStatus.Queued);
      expect(repo.runs[0].leaseToken).toBeNull();
    });
  });

  describe('cancelRun of a paused run', () => {
    it('asks the live job to stop waiting and clean up', async () => {
      const run = repo.addRun({
        userId,
        exportId,
        status: TakeoutRunStatus.Paused,
        leaseToken: 'job',
        heartbeatAt: new Date(),
        readStats: { pausedAt: new Date().toISOString(), pausedFrom: TakeoutRunStatus.Reading },
      });
      const result = await sut.cancelRun(auth, run.id);
      expect(result.status).toBe(TakeoutRunStatus.Cancelling);
      expect(repo.runs[0].leaseToken).toBe('job');
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('TakeoutRunCancel', { runId: run.id });
    });

    it('cleans up a paused run whose job is gone (after a restart) right away, keeping its staging', async () => {
      const run = repo.addRun({
        userId,
        exportId,
        status: TakeoutRunStatus.Paused,
        hasStaging: true,
        readStats: {
          pausedAt: new Date().toISOString(),
          pausedFrom: TakeoutRunStatus.Reading,
          parts: { p1: { partId: 'p1', fileName: 'a.tgz', size: 10, status: 'paused' } },
        },
      });
      await mkdir(runStagingDir(folder, run.id), { recursive: true });
      const result = await sut.cancelRun(auth, run.id);
      expect(result).toMatchObject({ status: TakeoutRunStatus.Cancelled, pausedAt: null, hasStaging: true });
      expect(repo.runs[0].readStats.pausedAt).toBeUndefined();
      expect(repo.runs[0].readStats.parts.p1.status).toBe('pending');
      expect(await readdir(stagingRoot(folder))).toEqual([run.id]);
    });

    it('cleans up the paused run of a trashed user whose job is gone', async () => {
      repo.addRun({ userId, exportId, status: TakeoutRunStatus.Paused });
      const live = repo.addRun({
        userId,
        exportId,
        status: TakeoutRunStatus.Paused,
        leaseToken: 'job',
        heartbeatAt: new Date(),
      });
      await sut.onUserTrash({ id: userId });
      expect(repo.runs.map((r) => r.status)).toEqual([TakeoutRunStatus.Cancelled, TakeoutRunStatus.Cancelling]);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('TakeoutRunCancel', { runId: live.id });
    });
  });

  describe('rescanExport', () => {
    it('resets the parts in error only, and queues the analysis', async () => {
      const bad = addPart({ catalogStatus: TakeoutCatalogStatus.Error, catalogVersion: 2, catalogError: 'truncated' });
      const good = addPart({ catalogStatus: TakeoutCatalogStatus.Complete, catalogVersion: 2 });
      repo.entries.push({ id: 1, exportId, partId: bad.id, seq: 0 }, { id: 2, exportId, partId: good.id, seq: 0 });
      await sut.rescanExport(auth, exportId);
      expect(bad.catalogStatus).toBe(TakeoutCatalogStatus.None);
      expect(bad.catalogError).toBeNull();
      expect(good.catalogStatus).toBe(TakeoutCatalogStatus.Complete);
      expect(repo.entries.map((e) => e.partId)).toEqual([good.id]);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.TakeoutAnalyzeExport, data: { exportId } });
    });
  });

  describe('boot recovery', () => {
    it('resets reading parts, reclaims legacy targets and does not wait for the sweep', async () => {
      const part = addPart({ catalogStatus: TakeoutCatalogStatus.Reading, lastReadRunId: randomUUID() });
      const run = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Failed });
      const target = join(dir, 'upload', userId, 'partial.jpg');
      await mkdir(join(dir, 'upload', userId), { recursive: true });
      await writeFile(target, 'partial');
      await repo.insertRunFiles([
        {
          runId: run.id,
          seq: 0,
          takeoutPath: 'a',
          size: 100,
          checksum: Buffer.alloc(20),
          fileKind: 'image',
          action: TakeoutRunFileAction.Upload,
          status: TakeoutRunFileStatus.Planned,
          targetPath: target,
          entrySeq: null,
        },
      ]);
      const sweep = vitest.spyOn(sut, 'sweepStaging').mockReturnValue(new Promise(() => {}));
      await sut.recoverAtBoot();
      expect(part.catalogStatus).toBe(TakeoutCatalogStatus.Partial);
      expect(repo.runFiles[0].targetPath).toBeNull();
      await expect(stat(target)).rejects.toThrow();
      expect(sweep).toHaveBeenCalled();
    });

    it('never picks up a run again whose target is the original of an asset, and never recreates its staging', async () => {
      // a Discarded run: an error row whose asset was created before a later step failed keeps its file
      const run = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Cancelled, hasStaging: false });
      const target = await writeUploadFile(dir, 'original.jpg');
      await repo.insertRunFiles([targetRow(run.id, target)]);
      repo.addAsset({
        id: repo.runFiles[0].newAssetId,
        ownerId: userId,
        checksum: Buffer.alloc(20),
        originalPath: target,
      });
      vitest.spyOn(sut, 'sweepStaging').mockResolvedValue();
      for (let boot = 0; boot < 2; boot++) {
        await sut.recoverAtBoot();
        expect(repo.runs[0].hasStaging).toBe(false);
        await expect(stat(runStagingDir(folder, run.id))).rejects.toThrow();
        expect(await stat(target)).toBeTruthy();
      }
      await expect(repo.getStoppedRunsWithTargets()).resolves.toEqual([]);
    });

    it('unlinks the stray targets of a run without staging instead of giving it a staging directory', async () => {
      const run = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Cancelled, hasStaging: false });
      const target = await writeUploadFile(dir, 'stray.jpg');
      await repo.insertRunFiles([targetRow(run.id, target, { status: TakeoutRunFileStatus.Skipped })]);
      vitest.spyOn(sut, 'sweepStaging').mockResolvedValue();
      await sut.recoverAtBoot();
      await expect(stat(target)).rejects.toThrow();
      expect(repo.runFiles[0].targetPath).toBeNull();
      expect(repo.runs[0].hasStaging).toBe(false);
      await expect(stat(runStagingDir(folder, run.id))).rejects.toThrow();
    });

    it('unlinks the asset-less error targets an old completed run left under upload/ (I4)', async () => {
      const run = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Completed });
      const target = await writeUploadFile(dir, 'orphan.jpg');
      await repo.insertRunFiles([targetRow(run.id, target, { entrySeq: null })]);
      vitest.spyOn(sut, 'sweepStaging').mockResolvedValue();
      await sut.recoverAtBoot();
      await expect(stat(target)).rejects.toThrow();
      expect(repo.runFiles[0].targetPath).toBeNull();
      expect(repo.runs[0].hasStaging).toBe(false);
      await expect(repo.getStoppedRunsWithTargets()).resolves.toEqual([]);
    });

    it('leaves the targets of a run resumed after the listing to its job', async () => {
      const run = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Failed, hasStaging: true });
      const target = await writeUploadFile(dir, 'resumed.jpg');
      await repo.insertRunFiles([targetRow(run.id, target, { status: TakeoutRunFileStatus.Written })]);
      const list = repo.getStoppedRunsWithTargets.bind(repo);
      vitest.spyOn(repo, 'getStoppedRunsWithTargets').mockImplementation(async () => {
        const listed = await list();
        await repo.requeueRun(run.id, 1);
        return listed;
      });
      vitest.spyOn(sut, 'sweepStaging').mockResolvedValue();
      await sut.recoverAtBoot();
      expect(await stat(target)).toBeTruthy();
      expect(repo.runFiles[0].targetPath).toBe(target);
    });

    it('keeps a paused run paused: its lease goes, nothing is queued, its parts can be continued', async () => {
      const run = repo.addRun({
        userId,
        exportId,
        status: TakeoutRunStatus.Paused,
        leaseToken: 'dead-job',
        heartbeatAt: new Date(),
        attempt: 1,
        readStats: { pausedAt: new Date().toISOString(), pausedFrom: TakeoutRunStatus.Reading },
      });
      const part = addPart({ catalogStatus: TakeoutCatalogStatus.Reading, lastReadRunId: run.id });
      vitest.spyOn(sut, 'sweepStaging').mockResolvedValue();
      await sut.recoverAtBoot();
      expect(repo.runs[0]).toMatchObject({
        status: TakeoutRunStatus.Paused,
        leaseToken: null,
        heartbeatAt: null,
        attempt: 1,
      });
      expect(repo.runs[0].readStats.pausedFrom).toBe(TakeoutRunStatus.Reading);
      expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.TakeoutRun }));
      // the part the paused run was reading continues on Resume (zip at its next entry, tgz from byte 0)
      expect(part.catalogStatus).toBe(TakeoutCatalogStatus.Partial);
    });

    it('re-queues running runs', async () => {
      const run = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Fetching, attempt: 2 });
      vitest.spyOn(sut, 'sweepStaging').mockResolvedValue();
      await sut.recoverAtBoot();
      expect(repo.runs.find((r) => r.id === run.id)!.attempt).toBe(3);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.TakeoutRun, data: { runId: run.id, attempt: 3 } });
    });
  });

  describe('staging sweep (5.3)', () => {
    it('keeps what runs or may be resumed, removes the rest', async () => {
      const running = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Reading });
      const recent = repo.addRun({
        userId,
        exportId,
        status: TakeoutRunStatus.Failed,
        hasStaging: true,
        finishedAt: new Date(),
      });
      const expired = repo.addRun({
        userId,
        exportId,
        status: TakeoutRunStatus.Cancelled,
        hasStaging: true,
        finishedAt: new Date(Date.now() - STAGING_TTL_MS - HOUR),
      });
      const completed = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Completed });
      const successor = repo.addRun({ userId, exportId, status: TakeoutRunStatus.Queued });
      const adopted = repo.addRun({
        userId,
        exportId,
        status: TakeoutRunStatus.Cancelled,
        supersededBy: successor.id,
      });
      const fresh = randomUUID();
      for (const run of [running, recent, expired, completed, adopted]) {
        await stagingDir(run.id);
      }
      await stagingDir(randomUUID());
      await stagingDir('garbage');
      await stagingDir(fresh, 10_000);
      await stagingDir('.trash-old-0');

      await sut.sweepStaging();
      expect(await names()).toEqual([running.id, recent.id, adopted.id, fresh].toSorted((a, b) => a.localeCompare(b)));
      expect(repo.runs.find((r) => r.id === expired.id)!.hasStaging).toBe(false);
      expect(repo.runs.find((r) => r.id === expired.id)!.status).toBe(TakeoutRunStatus.Cancelled);
    });

    it('keeps the staging of a paused run however long it is paused', async () => {
      const paused = repo.addRun({
        userId,
        exportId,
        status: TakeoutRunStatus.Paused,
        hasStaging: true,
        finishedAt: null,
      });
      await stagingDir(paused.id, STAGING_TTL_MS + HOUR);
      await sut.sweepStaging(Date.now() + 30 * 24 * HOUR);
      expect(await names()).toEqual([paused.id]);
      expect(repo.runs[0].hasStaging).toBe(true);
    });

    it('keeps the directory of a run resumed between the listing and the claim', async () => {
      const run = repo.addRun({
        userId,
        exportId,
        status: TakeoutRunStatus.Failed,
        hasStaging: true,
        finishedAt: new Date(Date.now() - STAGING_TTL_MS - HOUR),
      });
      await stagingDir(run.id);
      const claim = repo.claimExpiredStaging.bind(repo);
      vitest.spyOn(repo, 'claimExpiredStaging').mockImplementation(async (id, ttl) => {
        await repo.requeueRun(id, 1);
        return claim(id, ttl);
      });
      await sut.sweepStaging();
      expect(await names()).toEqual([run.id]);
    });
  });
});
