import { randomUUID } from 'node:crypto';
import {
  AssetType,
  TakeoutCatalogStatus,
  TakeoutEntryKind,
  TakeoutRunFileAction,
  TakeoutRunFileStatus,
  TakeoutRunStatus,
} from 'src/enum';
import {
  CachedEntryRow,
  CounterRowResult,
  RUN_FILE_INSERT_CHUNK,
  TAKEOUT_ACTIVE_RUN_STATUSES,
  TAKEOUT_CANCELLED_FLAG,
  TAKEOUT_RUNNING_RUN_STATUSES,
} from 'src/repositories/takeout.repository';

// An in-memory TakeoutRepository (and the few asset queries the takeout services make) for unit tests that run the
// reading, planning, fetching and finalize steps for real against temp files. Constraints the real schema enforces
// are enforced here too: unique (partId, seq), unique (runId, seq), jsonb refusing \u0000, status check-and-set.

type Row = Record<string, any> & { id?: any };

export interface MemoryAsset {
  id: string;
  ownerId: string;
  libraryId: string | null;
  checksum: Buffer;
  originalPath: string;
  originalFileName: string;
  fileSizeInByte: number | null;
  deletedAt: Date | null;
  createdAt: Date;
  type: AssetType;
}

const clone = <T>(row: T): T => ({ ...row });

async function* iterate<T>(rows: T[]): AsyncIterable<T> {
  for (const row of rows) {
    yield await row;
  }
}

function assertJsonb(row: Row) {
  if (row.json && JSON.stringify(row.json).includes(String.raw`\u0000`)) {
    throw new Error('unsupported Unicode escape sequence');
  }
}

export class TakeoutMemoryRepository {
  folders: Row[] = [];
  exports: Row[] = [];
  parts: Row[] = [];
  entries: Row[] = [];
  runs: Row[] = [];
  runFiles: Row[] = [];
  deletedChecksums: Array<{ ownerId: string; checksum: Buffer }> = [];
  assets: MemoryAsset[] = [];
  largerVersions: Row[] = [];
  private nextEntryId = 1;
  private nextRunFileId = 1;
  /** calls, for assertions */
  calls: Record<string, number> = {};
  /** fault injection: throw from commitPlan, insertEntries, ... */
  failNext: Record<string, Error | undefined> = {};

  private count(name: string) {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    const failure = this.failNext[name];
    if (failure) {
      this.failNext[name] = undefined;
      throw failure;
    }
  }

  // ---------- seeding helpers ----------

  addFolder(userId: string, folderName: string) {
    this.folders.push({ userId, folderName, createdAt: new Date() });
  }

  addExport(row: Partial<Row> & { userId: string }): any {
    const exp = {
      id: randomUUID(),
      exportKey: '20260914T211500Z-1',
      exportedAt: new Date('2026-09-14T21:15:00Z'),
      splitSize: null,
      completeness: 'complete',
      indexFileName: null,
      accountEmail: null,
      googleJobId: null,
      indexTotalSize: null,
      indexFileCount: null,
      indexCreatedText: null,
      analysis: {},
      analysisInputsAt: null,
      analyzedAt: null,
      archivesDeletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...row,
    };
    this.exports.push(exp);
    return exp;
  }

  addPart(row: Partial<Row> & { exportId: string; userId: string; fileName: string }): any {
    const part = {
      id: randomUUID(),
      timestamp: '20260914T211500Z',
      segment: 1,
      partNumber: 1,
      kind: row.fileName.endsWith('.zip') ? 'zip' : 'tgz',
      isIndex: false,
      size: 0,
      mtime: new Date(0),
      ctime: new Date(0),
      prevSyncSize: null,
      isMissing: false,
      catalogStatus: TakeoutCatalogStatus.None,
      catalogVersion: null,
      catalogSize: null,
      catalogMtime: null,
      catalogError: null,
      catalogErrorOffset: null,
      lastReadRunId: null,
      bytesRead: 0,
      entryCount: null,
      createdAt: new Date(),
      ...row,
    };
    this.parts.push(part);
    return part;
  }

  addRun(row: Partial<Row> & { userId: string; exportId: string }): any {
    const run = {
      id: randomUUID(),
      status: TakeoutRunStatus.Queued,
      importAnyway: false,
      settings: {},
      templateVars: { date: '2026-09-14', user: 'me', start: '2026-09-14 00:00:00' },
      counters: {},
      bytesTotal: 0,
      bytesDone: 0,
      archiveBytesTotal: 0,
      archiveBytesRead: 0,
      readStats: {},
      hasStaging: false,
      supersededBy: null,
      currentFile: null,
      error: null,
      heartbeatAt: null,
      leaseToken: null,
      attempt: 0,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...row,
    };
    this.runs.push(run);
    return run;
  }

  addAsset(row: Partial<MemoryAsset> & { ownerId: string; checksum: Buffer; originalPath: string }): MemoryAsset {
    const asset: MemoryAsset = {
      id: randomUUID(),
      libraryId: null,
      originalFileName: 'file',
      fileSizeInByte: null,
      deletedAt: null,
      createdAt: new Date(0),
      type: AssetType.Image,
      ...row,
    };
    this.assets.push(asset);
    return asset;
  }

  // ---------- lock ----------

  private locks = new Map<string, Promise<unknown>>();

  /** a real per-user mutex, like the advisory lock */
  withUserSyncLock<T>(userId: string, fn: (tx: any) => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => fn(null));
    this.locks.set(
      userId,
      next.catch(() => {}),
    );
    return next;
  }

  // ---------- folders ----------

  getFolder(userId: string) {
    return Promise.resolve(this.folders.find((f) => f.userId === userId));
  }

  getAllFolders() {
    return Promise.resolve(this.folders.map((f) => clone(f)));
  }

  getSettings() {
    return Promise.resolve(undefined);
  }

  getOrphanFolders() {
    return Promise.resolve([]);
  }

  // ---------- exports ----------

  createExport(row: Row) {
    return Promise.resolve(clone(this.addExport(row as any)));
  }

  createPart(row: Row) {
    return Promise.resolve(clone(this.addPart(row as any)));
  }

  getExport(id: string) {
    const exp = this.exports.find((e) => e.id === id);
    return Promise.resolve(exp ? clone(exp) : undefined);
  }

  getExportsByUser(userId: string) {
    return Promise.resolve(this.exports.filter((e) => e.userId === userId).map((e) => clone(e)));
  }

  updateExport(id: string, patch: Row) {
    const exp = this.exports.find((e) => e.id === id);
    if (exp) {
      Object.assign(exp, patch, { updatedAt: new Date() });
    }
    return Promise.resolve();
  }

  deleteExport(id: string) {
    this.exports = this.exports.filter((e) => e.id !== id);
    const runIds = new Set(this.runs.filter((r) => r.exportId === id).map((r) => r.id));
    this.runs = this.runs.filter((r) => r.exportId !== id);
    this.runFiles = this.runFiles.filter((f) => !runIds.has(f.runId));
    this.parts = this.parts.filter((p) => p.exportId !== id);
    this.entries = this.entries.filter((e) => e.exportId !== id);
    return Promise.resolve();
  }

  getExportsNeedingAnalysis() {
    return Promise.resolve([]);
  }

  // ---------- parts ----------

  private sortedParts(exportId: string) {
    return this.parts
      .filter((p) => p.exportId === exportId)
      .toSorted((a, b) => (a.segment ?? -1) - (b.segment ?? -1) || a.partNumber - b.partNumber);
  }

  getPartsByExport(exportId: string) {
    return Promise.resolve(this.sortedParts(exportId).map((p) => clone(p)));
  }

  getPartsByUser(userId: string) {
    return Promise.resolve(this.parts.filter((p) => p.userId === userId).map((p) => clone(p)));
  }

  getPart(id: string) {
    const part = this.parts.find((p) => p.id === id);
    return Promise.resolve(part ? clone(part) : undefined);
  }

  updatePart(id: string, patch: Row) {
    const part = this.parts.find((p) => p.id === id);
    if (part) {
      Object.assign(part, patch);
    }
    return Promise.resolve();
  }

  markPartMissing(id: string) {
    this.entries = this.entries.filter((e) => e.partId !== id);
    return this.updatePart(id, { isMissing: true, catalogStatus: TakeoutCatalogStatus.None, entryCount: null });
  }

  completePart(id: string, rows: Row[], patch: { bytesRead: number }) {
    this.count('completePart');
    this.insertRows(rows);
    const entryCount = this.entries.filter((e) => e.partId === id).length;
    return this.updatePart(id, {
      catalogStatus: TakeoutCatalogStatus.Complete,
      entryCount,
      bytesRead: patch.bytesRead,
      catalogError: null,
      catalogErrorOffset: null,
    });
  }

  failPart(
    id: string,
    options: {
      deleteEntries?: boolean;
      errorRow?: Row | null;
      catalogError: string;
      offset: number | null;
      bytesRead: number;
    },
  ) {
    this.count('failPart');
    if (options.deleteEntries) {
      this.entries = this.entries.filter((e) => e.partId !== id);
    } else if (options.errorRow) {
      this.insertRows([options.errorRow]);
    }
    return this.updatePart(id, {
      catalogStatus: TakeoutCatalogStatus.Error,
      catalogError: options.catalogError,
      catalogErrorOffset: options.offset,
      bytesRead: options.bytesRead,
    });
  }

  updatePartsOfRun(runId: string) {
    for (const part of this.parts) {
      if (part.lastReadRunId === runId && part.catalogStatus === TakeoutCatalogStatus.Reading) {
        part.catalogStatus = TakeoutCatalogStatus.Partial;
      }
    }
    return Promise.resolve();
  }

  resetReadingParts() {
    for (const part of this.parts) {
      const run = this.runs.find((r) => r.id === part.lastReadRunId);
      if (
        part.catalogStatus === TakeoutCatalogStatus.Reading &&
        !(run && TAKEOUT_RUNNING_RUN_STATUSES.includes(run.status))
      ) {
        part.catalogStatus = TakeoutCatalogStatus.Partial;
      }
    }
    return Promise.resolve();
  }

  // ---------- entries ----------

  private insertRows(rows: Row[]) {
    for (const row of rows) {
      assertJsonb(row);
    }
    for (const row of rows) {
      if (this.entries.some((e) => e.partId === row.partId && e.seq === row.seq)) {
        continue;
      }
      this.entries.push({ ...row, id: this.nextEntryId++ });
    }
  }

  insertEntries(rows: Row[]) {
    this.count('insertEntries');
    this.insertRows(rows);
    return Promise.resolve();
  }

  insertEntry(row: Row) {
    this.count('insertEntry');
    this.insertRows([row]);
    return Promise.resolve();
  }

  deleteEntriesOfPart(partId: string) {
    this.entries = this.entries.filter((e) => e.partId !== partId);
    return Promise.resolve();
  }

  deleteEntriesOfExport(exportId: string) {
    this.entries = this.entries.filter((e) => e.exportId !== exportId);
    return Promise.resolve();
  }

  getMaxEntrySeq(partId: string) {
    const seqs = this.entries.filter((e) => e.partId === partId).map((e) => e.seq);
    return Promise.resolve(seqs.length > 0 ? Math.max(...seqs) : null);
  }

  countEntries(partId: string) {
    return Promise.resolve(this.entries.filter((e) => e.partId === partId).length);
  }

  getEntriesForSkip(partId: string) {
    const map = new Map<number, CachedEntryRow>();
    for (const e of this.entries) {
      if (e.partId !== partId) {
        continue;
      }
      map.set(e.seq, { seq: e.seq, path: e.path, size: Number(e.size), kind: e.kind, checksum: e.checksum });
    }
    return Promise.resolve(map);
  }

  getMediaEntryPaths(exportId: string) {
    return Promise.resolve(
      this.entries.filter((e) => e.exportId === exportId && e.kind === TakeoutEntryKind.Media).map((e) => e.path),
    );
  }

  getEntriesWithoutSample(exportId: string) {
    return Promise.resolve(
      this.entries
        .filter(
          (e) =>
            e.exportId === exportId && e.kind === TakeoutEntryKind.Media && !e.sample && !e.sampleSkipped && e.checksum,
        )
        .map((e) => ({
          id: e.id,
          partId: e.partId,
          seq: e.seq,
          path: e.path,
          size: e.size,
          checksum: e.checksum,
          partName: this.parts.find((p) => p.id === e.partId)?.fileName,
        })),
    );
  }

  updateEntry(id: number, patch: Row) {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) {
      Object.assign(entry, patch);
    }
    return Promise.resolve();
  }

  pruneSamples(exportId: string, keepPaths: string[]) {
    const keep = new Set(keepPaths);
    for (const entry of this.entries) {
      if (entry.exportId === exportId && entry.sample && !keep.has(entry.path)) {
        entry.sample = null;
      }
    }
    return Promise.resolve();
  }

  streamEntriesForExport(exportId: string, options: { catalogVersion: number; excludePartIds?: string[] }) {
    const excluded = new Set(options.excludePartIds);
    const rows: Row[] = [];
    for (const part of this.sortedParts(exportId)) {
      if (
        part.catalogVersion !== options.catalogVersion ||
        ![TakeoutCatalogStatus.Complete, TakeoutCatalogStatus.Error].includes(part.catalogStatus) ||
        part.isMissing ||
        excluded.has(part.id)
      ) {
        continue;
      }
      for (const entry of this.entries.filter((e) => e.partId === part.id).toSorted((a, b) => a.seq - b.seq)) {
        rows.push({
          ...entry,
          partName: part.fileName,
          partNumber: part.partNumber,
          segment: part.segment,
          width: entry.width ?? null,
          height: entry.height ?? null,
          sample: entry.sample ?? null,
          readError: entry.readError ?? null,
        });
      }
    }
    return iterate(rows);
  }

  getCataloguedMediaPaths(exportId: string, catalogVersion: number) {
    const parts = new Set(
      this.parts
        .filter(
          (p) =>
            p.exportId === exportId &&
            p.catalogVersion === catalogVersion &&
            p.catalogStatus === TakeoutCatalogStatus.Complete,
        )
        .map((p) => p.id),
    );
    return Promise.resolve(
      this.entries.filter((e) => parts.has(e.partId) && e.kind === TakeoutEntryKind.Media).map((e) => e.path),
    );
  }

  getEntryOccurrences(exportId: string, checksums: Buffer[], catalogVersion: number) {
    const wanted = new Set(checksums.map((c) => c.toString('hex')));
    const rows: Row[] = [];
    for (const entry of this.entries) {
      const part = this.parts.find((p) => p.id === entry.partId);
      if (
        entry.exportId !== exportId ||
        !entry.checksum ||
        !wanted.has(entry.checksum.toString('hex')) ||
        !part ||
        part.catalogVersion !== catalogVersion ||
        part.catalogStatus === TakeoutCatalogStatus.None ||
        part.isMissing
      ) {
        continue;
      }
      rows.push({
        checksum: entry.checksum,
        partId: entry.partId,
        seq: entry.seq,
        path: entry.path,
        size: entry.size,
        endOffset: entry.endOffset ?? null,
        partName: part.fileName,
        kind: part.kind,
      });
    }
    return Promise.resolve(rows);
  }

  // ---------- server content ----------

  private uploadAssets(userId: string) {
    return this.assets.filter((a) => a.ownerId === userId && a.libraryId === null);
  }

  streamUploadChecksums(userId: string) {
    return iterate(this.uploadAssets(userId).map((a) => ({ checksum: a.checksum })));
  }

  streamDeletedChecksums(userId: string) {
    return iterate(this.deletedChecksums.filter((d) => d.ownerId === userId).map((d) => ({ checksum: d.checksum })));
  }

  getUploadAssetSizesOver(userId: string, size: number) {
    const sizes = new Set<number>();
    for (const asset of this.uploadAssets(userId)) {
      if (asset.fileSizeInByte !== null && asset.fileSizeInByte > size) {
        sizes.add(asset.fileSizeInByte);
      }
    }
    return Promise.resolve([...sizes]);
  }

  getUploadAssetsBySize(userId: string, size: number, limit: number) {
    return Promise.resolve(
      this.uploadAssets(userId)
        .filter((a) => a.fileSizeInByte === size)
        .slice(0, limit)
        .map((a) => ({ id: a.id, originalPath: a.originalPath })),
    );
  }

  getUploadAssetsByChecksums(userId: string, checksums: Buffer[]) {
    const wanted = new Set(checksums.map((c) => c.toString('hex')));
    return Promise.resolve(
      this.uploadAssets(userId)
        .filter((a) => wanted.has(a.checksum.toString('hex')))
        .map((a) => ({ id: a.id, checksum: a.checksum, deletedAt: a.deletedAt, originalPath: a.originalPath })),
    );
  }

  streamAssetsForNameMatch(userId: string, before: Date) {
    return iterate(
      this.uploadAssets(userId)
        .filter((a) => !a.deletedAt && a.createdAt < before)
        .map((a) => ({
          id: a.id,
          originalFileName: a.originalFileName,
          at: null,
          fileSizeInByte: a.fileSizeInByte,
          checksum: a.checksum,
        })),
    );
  }

  // ---------- runs ----------

  createRun(row: Row) {
    return Promise.resolve(clone(this.addRun(row as any)));
  }

  createRunWithAdoption(row: Row, adoptFromRunId: string | null) {
    const run = this.addRun(row as any);
    let adopted = false;
    const old = this.runs.find((r) => r.id === adoptFromRunId);
    if (
      old &&
      [TakeoutRunStatus.Failed, TakeoutRunStatus.Cancelled].includes(old.status) &&
      old.supersededBy === null
    ) {
      Object.assign(old, {
        supersededBy: run.id,
        status: TakeoutRunStatus.Cancelled,
        hasStaging: false,
        error: `superseded by ${run.id}`,
        leaseToken: null,
      });
      for (const file of this.runFiles) {
        if (
          file.runId === old.id &&
          [TakeoutRunFileStatus.Planned, TakeoutRunFileStatus.Written].includes(file.status)
        ) {
          Object.assign(file, { status: TakeoutRunFileStatus.Skipped, reason: 'superseded' });
        }
      }
      adopted = true;
    }
    return Promise.resolve({ run: clone(run), adopted });
  }

  getRun(id: string) {
    const run = this.runs.find((r) => r.id === id);
    return Promise.resolve(run ? clone(run) : undefined);
  }

  getRunsByExport(exportId: string) {
    return Promise.resolve(
      this.runs
        .filter((r) => r.exportId === exportId)
        .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((r) => clone(r)),
    );
  }

  getActiveRun(userId: string) {
    const run = this.runs.find((r) => r.userId === userId && TAKEOUT_ACTIVE_RUN_STATUSES.includes(r.status));
    return Promise.resolve(run ? clone(run) : undefined);
  }

  getActiveRunForExport(exportId: string) {
    const run = this.runs.find((r) => r.exportId === exportId && TAKEOUT_ACTIVE_RUN_STATUSES.includes(r.status));
    return Promise.resolve(run ? clone(run) : undefined);
  }

  getActiveRunsByUser(userId: string) {
    return Promise.resolve(
      this.runs
        .filter((r) => r.userId === userId && TAKEOUT_ACTIVE_RUN_STATUSES.includes(r.status))
        .map((r) => clone(r)),
    );
  }

  getAdoptableRun(exportId: string) {
    const run = this.runs
      .filter(
        (r) =>
          r.exportId === exportId &&
          [TakeoutRunStatus.Failed, TakeoutRunStatus.Cancelled].includes(r.status) &&
          r.hasStaging &&
          r.supersededBy === null,
      )
      .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return Promise.resolve(run ? clone(run) : undefined);
  }

  getRunsSupersededBy(runId: string) {
    return Promise.resolve(this.runs.filter((r) => r.supersededBy === runId).map((r) => clone(r)));
  }

  updateRun(id: string, patch: Row) {
    const run = this.runs.find((r) => r.id === id);
    if (run) {
      Object.assign(run, patch, { updatedAt: new Date() });
    }
    return Promise.resolve();
  }

  updateRunIfLeased(id: string, token: string, patch: Row) {
    const run = this.runs.find((r) => r.id === id);
    if (!run || run.leaseToken !== token || !TAKEOUT_RUNNING_RUN_STATUSES.includes(run.status)) {
      return Promise.resolve(false);
    }
    Object.assign(run, patch, { updatedAt: new Date() });
    return Promise.resolve(true);
  }

  setRunStatusCas(id: string, token: string, status: TakeoutRunStatus, patch: Row = {}) {
    this.count('setRunStatusCas');
    const run = this.runs.find((r) => r.id === id);
    if (!run || run.leaseToken !== token || !TAKEOUT_RUNNING_RUN_STATUSES.includes(run.status)) {
      return Promise.resolve(false);
    }
    Object.assign(run, patch, { status, updatedAt: new Date() });
    this.statusLog.push(status);
    return Promise.resolve(true);
  }

  statusLog: string[] = [];

  finishRunCas(id: string, from: TakeoutRunStatus[], token: string | null, status: TakeoutRunStatus, patch: Row = {}) {
    const run = this.runs.find((r) => r.id === id);
    if (!run || !from.includes(run.status) || (token !== null && run.leaseToken !== token)) {
      return Promise.resolve(false);
    }
    Object.assign(run, patch, { status, leaseToken: null, updatedAt: new Date() });
    this.statusLog.push(status);
    return Promise.resolve(true);
  }

  private leaseStale(run: Row) {
    return !run.heartbeatAt || Date.now() - run.heartbeatAt.getTime() > 60_000;
  }

  claimRunForCancel(id: string, from: TakeoutRunStatus[], token: string) {
    this.count('claimRunForCancel');
    const run = this.runs.find((r) => r.id === id);
    if (
      !run ||
      !from.includes(run.status) ||
      !(run.leaseToken === null || run.leaseToken === token || this.leaseStale(run))
    ) {
      return Promise.resolve(false);
    }
    Object.assign(run, { status: TakeoutRunStatus.Cancelling, leaseToken: token, heartbeatAt: new Date() });
    this.statusLog.push(TakeoutRunStatus.Cancelling);
    return Promise.resolve(true);
  }

  renewCancelLease(id: string, token: string) {
    const run = this.runs.find((r) => r.id === id);
    if (!run || run.leaseToken !== token || run.status !== TakeoutRunStatus.Cancelling) {
      return Promise.resolve(false);
    }
    run.heartbeatAt = new Date();
    return Promise.resolve(true);
  }

  requestCancel(id: string) {
    const run = this.runs.find((r) => r.id === id);
    if (!run || !TAKEOUT_RUNNING_RUN_STATUSES.includes(run.status)) {
      return Promise.resolve(false);
    }
    run.status = TakeoutRunStatus.Cancelling;
    return Promise.resolve(true);
  }

  getInterruptedRuns() {
    return Promise.resolve(
      this.runs.filter((r) => TAKEOUT_ACTIVE_RUN_STATUSES.includes(r.status)).map((r) => clone(r)),
    );
  }

  takeLease(runId: string, token: string) {
    const run = this.runs.find((r) => r.id === runId);
    if (!run || !TAKEOUT_RUNNING_RUN_STATUSES.includes(run.status)) {
      return Promise.resolve(false);
    }
    if (run.leaseToken === null || run.leaseToken === token || this.leaseStale(run)) {
      run.leaseToken = token;
      run.heartbeatAt = new Date();
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  requeueRun(id: string, attempt: number) {
    const run = this.runs.find((r) => r.id === id);
    if (
      !run ||
      ![TakeoutRunStatus.Failed, TakeoutRunStatus.Cancelled].includes(run.status) ||
      run.supersededBy !== null
    ) {
      return Promise.resolve(false);
    }
    Object.assign(run, {
      status: TakeoutRunStatus.Queued,
      error: null,
      heartbeatAt: null,
      leaseToken: null,
      finishedAt: null,
      attempt,
    });
    const resumable = new Set<string>([
      TakeoutRunFileAction.Upload,
      TakeoutRunFileAction.ServerDuplicate,
      TakeoutRunFileAction.BetterOnServer,
      TakeoutRunFileAction.AlreadyProcessed,
    ]);
    for (const file of this.runFiles) {
      const flagged = (file.fallbacks ?? []).includes(TAKEOUT_CANCELLED_FLAG);
      if (
        file.runId !== id ||
        file.status !== TakeoutRunFileStatus.Skipped ||
        !resumable.has(file.action) ||
        !(flagged || file.reason === 'cancelled')
      ) {
        continue;
      }
      let reason = file.reason;
      if (reason === 'cancelled') {
        reason =
          file.action === TakeoutRunFileAction.Upload && file.smallerAssetId
            ? 'server had a smaller version'
            : file.action === TakeoutRunFileAction.ServerDuplicate
              ? 'already on the server'
              : file.action === TakeoutRunFileAction.BetterOnServer
                ? 'the server already has a larger version'
                : null;
      }
      Object.assign(file, {
        status: TakeoutRunFileStatus.Planned,
        reason,
        fallbacks: (file.fallbacks ?? []).filter((flag: string) => flag !== TAKEOUT_CANCELLED_FLAG),
      });
    }
    return Promise.resolve(true);
  }

  claimExpiredStaging(runId: string, ttlMs: number) {
    const run = this.runs.find((r) => r.id === runId);
    if (
      !run ||
      ![TakeoutRunStatus.Failed, TakeoutRunStatus.Cancelled].includes(run.status) ||
      !run.finishedAt ||
      Date.now() - run.finishedAt.getTime() <= ttlMs
    ) {
      return Promise.resolve(false);
    }
    run.hasStaging = false;
    return Promise.resolve(true);
  }

  getStoppedRunsWithTargets() {
    const strayTargets = (runId: string, statuses: string[]) =>
      this.runFiles.some(
        (f) =>
          f.runId === runId &&
          f.action === TakeoutRunFileAction.Upload &&
          f.targetPath &&
          statuses.includes(f.status) &&
          this.assets.every((asset) => asset.id !== f.newAssetId),
      );
    return Promise.resolve(
      this.runs
        .filter(
          (r) =>
            !r.supersededBy &&
            (([TakeoutRunStatus.Failed, TakeoutRunStatus.Cancelled].includes(r.status) &&
              strayTargets(r.id, [
                TakeoutRunFileStatus.Planned,
                TakeoutRunFileStatus.Written,
                TakeoutRunFileStatus.Error,
                TakeoutRunFileStatus.Skipped,
              ])) ||
              (r.status === TakeoutRunStatus.Completed && strayTargets(r.id, [TakeoutRunFileStatus.Error]))),
        )
        .map((r) => clone(r)),
    );
  }

  // ---------- run files ----------

  private insertRunFileRows(rows: Row[]) {
    for (const row of rows) {
      if (this.runFiles.some((f) => f.runId === row.runId && f.seq === row.seq)) {
        continue;
      }
      this.runFiles.push({
        id: this.nextRunFileId++,
        entrySeq: null,
        mtime: null,
        checksum: null,
        jsonPath: null,
        matcher: null,
        originalFileName: null,
        groupIndex: null,
        groupOrder: null,
        groupKind: null,
        isCover: false,
        reason: null,
        plan: null,
        dependsOnSeq: null,
        newAssetId: null,
        assetId: null,
        smallerAssetId: null,
        targetPath: null,
        captureDate: null,
        zone: null,
        zoneSource: null,
        fallbacks: [],
        rotation: 0,
        rotationState: null,
        error: null,
        ...row,
      });
    }
  }

  commitPlan(input: {
    runId: string;
    token: string;
    rows: Row[];
    nextStatus: TakeoutRunStatus;
    runPatch: Row;
    exportId: string;
    exportPatch: Row;
  }) {
    this.count('commitPlan');
    const run = this.runs.find((r) => r.id === input.runId);
    if (!run || run.leaseToken !== input.token || run.status !== TakeoutRunStatus.Planning) {
      return Promise.resolve(false);
    }
    this.calls.planChunks = (this.calls.planChunks ?? 0) + Math.ceil(input.rows.length / RUN_FILE_INSERT_CHUNK);
    Object.assign(run, input.runPatch, { status: input.nextStatus });
    this.statusLog.push(input.nextStatus);
    this.insertRunFileRows(input.rows);
    const exp = this.exports.find((e) => e.id === input.exportId);
    if (exp) {
      Object.assign(exp, input.exportPatch);
    }
    return Promise.resolve(true);
  }

  insertRunFiles(rows: Row[]) {
    this.insertRunFileRows(rows);
    return Promise.resolve();
  }

  updateRunFile(id: number | string, patch: Row) {
    const file = this.runFiles.find((f) => f.id === Number(id));
    if (file) {
      Object.assign(file, patch);
    }
    return Promise.resolve();
  }

  skipOpenRunFiles(runId: string) {
    for (const file of this.runFiles) {
      if (
        file.runId === runId &&
        [TakeoutRunFileStatus.Planned, TakeoutRunFileStatus.Written].includes(file.status) &&
        !file.targetPath
      ) {
        Object.assign(file, {
          status: TakeoutRunFileStatus.Skipped,
          fallbacks: [
            ...(file.fallbacks ?? []).filter((flag: string) => flag !== TAKEOUT_CANCELLED_FLAG),
            TAKEOUT_CANCELLED_FLAG,
          ],
        });
      }
    }
    return Promise.resolve();
  }

  getRunFilesForImport(runId: string) {
    return Promise.resolve(
      this.runFiles
        .filter((f) => f.runId === runId)
        .toSorted((a, b) => a.seq - b.seq)
        .map((f) => clone(f)),
    );
  }

  getRunFilesWithTarget(runId: string) {
    return Promise.resolve(this.runFiles.filter((f) => f.runId === runId && f.targetPath).map((f) => clone(f)));
  }

  countRunFiles(runId: string) {
    return Promise.resolve(this.runFiles.filter((f) => f.runId === runId).length);
  }

  countRunFilesByStatus(runId: string, status: string) {
    return Promise.resolve(this.runFiles.filter((f) => f.runId === runId && f.status === status).length);
  }

  getCounterRows(runId: string): Promise<CounterRowResult[]> {
    const groups = new Map<string, CounterRowResult>();
    for (const f of this.runFiles) {
      if (f.runId !== runId) {
        continue;
      }
      const key = JSON.stringify([
        f.action,
        f.status,
        f.fileKind,
        f.matcher,
        f.fallbacks,
        f.rotationState,
        f.isCover,
        f.groupKind,
        f.reason,
      ]);
      const group = groups.get(key);
      if (group) {
        group.count++;
      } else {
        groups.set(key, {
          action: f.action,
          status: f.status,
          fileKind: f.fileKind,
          matcher: f.matcher,
          fallbacks: f.fallbacks ?? [],
          rotationState: f.rotationState,
          isCover: f.isCover,
          groupKind: f.groupKind,
          reason: f.reason,
          count: 1,
        });
      }
    }
    return Promise.resolve(groups.values().toArray());
  }

  getRotationCounts() {
    return Promise.resolve({});
  }

  getPendingRotations() {
    return Promise.resolve([]);
  }

  getPostImportState(assetIds: string[]) {
    return Promise.resolve(
      assetIds.map((id) => ({
        id,
        type: AssetType.Image,
        hasThumbhash: true,
        metadataDone: true,
        hasPreview: true,
        hasThumbnail: true,
        hasEncodedVideo: false,
      })),
    );
  }

  insertLargerVersion(row: Row) {
    this.largerVersions.push(row);
    return Promise.resolve();
  }

  // ---------- the asset queries of the takeout services (asset repository fake) ----------

  assetRepository() {
    return {
      getByIds: (ids: string[]) =>
        Promise.resolve(this.assets.filter((a) => ids.includes(a.id)).map((a) => ({ ...a }))),
      create: (row: any) => {
        const asset = this.addAsset({
          id: row.id,
          ownerId: row.ownerId,
          checksum: row.checksum,
          originalPath: row.originalPath,
          originalFileName: row.originalFileName,
          createdAt: new Date(),
        });
        return Promise.resolve({ ...asset });
      },
      getUploadAssetIdByChecksum: (ownerId: string, checksum: Buffer) =>
        Promise.resolve(this.uploadAssets(ownerId).find((a) => a.checksum.equals(checksum))?.id),
      upsertExif: () => Promise.resolve(),
      upsertFile: () => Promise.resolve(),
      unlockProperties: () => Promise.resolve(),
      upsertMetadata: () => Promise.resolve(),
      getMetadataByKey: () => Promise.resolve(null),
      getById: () => Promise.resolve(null),
    };
  }
}
