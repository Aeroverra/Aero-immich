import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import {
  AssetFileType,
  TakeoutCatalogStatus,
  TakeoutEntryKind,
  TakeoutLargerVersionStatus,
  TakeoutRotationState,
  TakeoutRunFileAction,
  TakeoutRunFileStatus,
  TakeoutRunStatus,
} from 'src/enum';
import { DB } from 'src/schema';
import { TakeoutEntryTable } from 'src/schema/tables/takeout-entry.table';
import { TakeoutExportTable } from 'src/schema/tables/takeout-export.table';
import { TakeoutFolderTable } from 'src/schema/tables/takeout-folder.table';
import { TakeoutLargerVersionTable } from 'src/schema/tables/takeout-larger-version.table';
import { TakeoutPartTable } from 'src/schema/tables/takeout-part.table';
import { TakeoutRunFileTable } from 'src/schema/tables/takeout-run-file.table';
import { TakeoutRunTable } from 'src/schema/tables/takeout-run.table';
import { TakeoutUploadTable } from 'src/schema/tables/takeout-upload.table';

/** statuses a run job may work on (single-pass design 10.6) */
export const TAKEOUT_RUNNING_RUN_STATUSES = [
  TakeoutRunStatus.Queued,
  TakeoutRunStatus.Reading,
  TakeoutRunStatus.Planning,
  TakeoutRunStatus.Fetching,
  TakeoutRunStatus.Importing,
  TakeoutRunStatus.Finishing,
];

/** statuses that block a new run and mean the export must not be regrouped (running + cancelling) */
export const TAKEOUT_ACTIVE_RUN_STATUSES = [...TAKEOUT_RUNNING_RUN_STATUSES, TakeoutRunStatus.Cancelling];

/** plan inserts per statement: 1000 rows x 25 columns stays far below the 65534 parameters postgres.js allows */
export const RUN_FILE_INSERT_CHUNK = 1000;

export interface CounterRowResult {
  action: string;
  status: string;
  fileKind: string;
  matcher: string | null;
  fallbacks: string[];
  rotationState: string | null;
  isCover: boolean;
  groupKind: string | null;
  reason: string | null;
  count: number;
}

export interface CachedEntryRow {
  seq: number;
  path: string;
  size: number;
  kind: string;
  checksum: Buffer | null;
}

@Injectable()
export class TakeoutRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  // ---------- advisory lock ----------

  /** Runs `fn` while holding the per-user sync lock so timers, API calls and sweeps never interleave */
  withUserSyncLock<T>(userId: string, fn: (tx: Kysely<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${'takeout:' + userId}))`.execute(tx);
      return fn(tx);
    });
  }

  // ---------- folder ----------

  @GenerateSql({ params: [DummyValue.UUID] })
  getFolder(userId: string) {
    return this.db.selectFrom('takeout_folder').selectAll().where('userId', '=', userId).executeTakeFirst();
  }

  @GenerateSql()
  getAllFolders() {
    return this.db.selectFrom('takeout_folder').select(['userId', 'folderName']).execute();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, folderName: DummyValue.STRING }] })
  createFolder(folder: Insertable<TakeoutFolderTable>) {
    return this.db.insertInto('takeout_folder').values(folder).returningAll().executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteFolder(userId: string) {
    await this.db.deleteFrom('takeout_folder').where('userId', '=', userId).execute();
  }

  /** Folder rows whose user row no longer exists (boot recovery) */
  @GenerateSql()
  getOrphanFolders() {
    return this.db
      .selectFrom('takeout_folder')
      .leftJoin('user', 'user.id', 'takeout_folder.userId')
      .select(['takeout_folder.userId as userId', 'takeout_folder.folderName as folderName'])
      .where('user.id', 'is', null)
      .execute();
  }

  // ---------- settings ----------

  @GenerateSql({ params: [DummyValue.UUID] })
  getSettings(userId: string) {
    return this.db.selectFrom('takeout_settings').select('settings').where('userId', '=', userId).executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, {}] })
  async upsertSettings(userId: string, settings: object) {
    await this.db
      .insertInto('takeout_settings')
      .values({ userId, settings, updatedAt: sql`now()` })
      .onConflict((oc) =>
        oc.column('userId').doUpdateSet((eb) => ({
          settings: eb.ref('excluded.settings'),
          updatedAt: sql`now()`,
        })),
      )
      .execute();
  }

  // ---------- uploads ----------

  @GenerateSql({ params: [{ userId: DummyValue.UUID, fileName: DummyValue.STRING, size: 0 }] })
  createUpload(upload: Insertable<TakeoutUploadTable>) {
    return this.db.insertInto('takeout_upload').values(upload).returningAll().executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getUpload(id: string) {
    return this.db.selectFrom('takeout_upload').selectAll().where('id', '=', id).executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getUploadByName(userId: string, fileName: string) {
    return this.db
      .selectFrom('takeout_upload')
      .selectAll()
      .where('userId', '=', userId)
      .where('fileName', '=', fileName)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getUploads(userId: string) {
    return this.db
      .selectFrom('takeout_upload')
      .selectAll()
      .where('userId', '=', userId)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  /** Every open upload session, for the free-space preflight (remaining bytes of other sessions) */
  @GenerateSql()
  getAllUploads() {
    return this.db.selectFrom('takeout_upload').select(['id', 'userId', 'fileName', 'size']).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async touchUpload(id: string) {
    await this.db
      .updateTable('takeout_upload')
      .set({ updatedAt: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteUpload(id: string) {
    await this.db.deleteFrom('takeout_upload').where('id', '=', id).execute();
  }

  // ---------- exports ----------

  @GenerateSql({ params: [DummyValue.UUID] })
  getExportsByUser(userId: string) {
    return this.db
      .selectFrom('takeout_export')
      .selectAll()
      .where('userId', '=', userId)
      .orderBy('exportedAt', 'desc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getExport(id: string) {
    return this.db.selectFrom('takeout_export').selectAll().where('id', '=', id).executeTakeFirst();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, exportKey: DummyValue.STRING, exportedAt: DummyValue.DATE }] })
  createExport(row: Insertable<TakeoutExportTable>) {
    return this.db.insertInto('takeout_export').values(row).returningAll().executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, {}] })
  async updateExport(id: string, patch: Updateable<TakeoutExportTable>) {
    await this.db
      .updateTable('takeout_export')
      .set({ ...patch, updatedAt: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteExport(id: string) {
    await this.db.deleteFrom('takeout_export').where('id', '=', id).execute();
  }

  /** Exports whose analysis inputs are newer than the last analysis (boot recovery) */
  @GenerateSql()
  getExportsNeedingAnalysis() {
    return this.db
      .selectFrom('takeout_export')
      .select('id')
      .where((eb) => eb.or([eb('analyzedAt', 'is', null), eb(eb.ref('analysisInputsAt'), '>', eb.ref('analyzedAt'))]))
      .where('analysisInputsAt', 'is not', null)
      .execute();
  }

  // ---------- parts ----------

  @GenerateSql({ params: [DummyValue.UUID] })
  getPartsByUser(userId: string) {
    return this.db.selectFrom('takeout_part').selectAll().where('userId', '=', userId).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getPartsByExport(exportId: string) {
    return this.db
      .selectFrom('takeout_part')
      .selectAll()
      .where('exportId', '=', exportId)
      .orderBy('segment', sql`asc nulls first`)
      .orderBy('partNumber', 'asc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getPart(id: string) {
    return this.db.selectFrom('takeout_part').selectAll().where('id', '=', id).executeTakeFirst();
  }

  @GenerateSql({ params: [{ exportId: DummyValue.UUID, userId: DummyValue.UUID, fileName: DummyValue.STRING }] })
  createPart(row: Insertable<TakeoutPartTable>) {
    return this.db.insertInto('takeout_part').values(row).returningAll().executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, {}] })
  async updatePart(id: string, patch: Updateable<TakeoutPartTable>) {
    await this.db.updateTable('takeout_part').set(patch).where('id', '=', id).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deletePart(id: string) {
    await this.db.deleteFrom('takeout_part').where('id', '=', id).execute();
  }

  /** The file is gone: its rows go and its catalog is reset (what folder sync does for a vanished part) */
  @GenerateSql({ params: [DummyValue.UUID] })
  async markPartMissing(id: string) {
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('takeout_entry').where('partId', '=', id).execute();
      await tx
        .updateTable('takeout_part')
        .set({ isMissing: true, catalogStatus: TakeoutCatalogStatus.None, entryCount: null })
        .where('id', '=', id)
        .execute();
    });
  }

  /**
   * The last rows and the part state commit together: a crash never leaves a fully read part in 'reading'. The
   * entry count is taken inside the transaction, so rows of earlier passes (resume) count exactly once.
   */
  async completePart(id: string, rows: Insertable<TakeoutEntryTable>[], patch: { bytesRead: number }) {
    await this.db.transaction().execute(async (tx) => {
      if (rows.length > 0) {
        await tx
          .insertInto('takeout_entry')
          .values(rows)
          .onConflict((oc) => oc.columns(['partId', 'seq']).doNothing())
          .execute();
      }
      const counted = await tx
        .selectFrom('takeout_entry')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('partId', '=', id)
        .executeTakeFirst();
      await tx
        .updateTable('takeout_part')
        .set({
          catalogStatus: TakeoutCatalogStatus.Complete,
          entryCount: Number(counted?.count ?? 0),
          bytesRead: patch.bytesRead,
          catalogError: null,
          catalogErrorOffset: null,
        })
        .where('id', '=', id)
        .execute();
    });
  }

  /** A data error: the error row (the entry that was in flight) and the part state in one transaction */
  async failPart(
    id: string,
    options: {
      deleteEntries?: boolean;
      errorRow?: Insertable<TakeoutEntryTable> | null;
      catalogError: string;
      offset: number | null;
      bytesRead: number;
    },
  ) {
    await this.db.transaction().execute(async (tx) => {
      if (options.deleteEntries) {
        await tx.deleteFrom('takeout_entry').where('partId', '=', id).execute();
      } else if (options.errorRow) {
        await tx
          .insertInto('takeout_entry')
          .values(options.errorRow)
          .onConflict((oc) => oc.columns(['partId', 'seq']).doNothing())
          .execute();
      }
      await tx
        .updateTable('takeout_part')
        .set({
          catalogStatus: TakeoutCatalogStatus.Error,
          catalogError: options.catalogError,
          catalogErrorOffset: options.offset,
          bytesRead: options.bytesRead,
        })
        .where('id', '=', id)
        .execute();
    });
  }

  /** Parts left 'reading' by a run that stopped: their rows are a valid prefix */
  @GenerateSql({ params: [DummyValue.UUID] })
  async updatePartsOfRun(runId: string) {
    await this.db
      .updateTable('takeout_part')
      .set({ catalogStatus: TakeoutCatalogStatus.Partial })
      .where('lastReadRunId', '=', runId)
      .where('catalogStatus', '=', TakeoutCatalogStatus.Reading)
      .execute();
  }

  /** Boot: parts in 'reading' whose run is not running any more */
  @GenerateSql()
  async resetReadingParts() {
    await this.db
      .updateTable('takeout_part')
      .set({ catalogStatus: TakeoutCatalogStatus.Partial })
      .where('catalogStatus', '=', TakeoutCatalogStatus.Reading)
      .where((eb) =>
        eb.or([
          eb('lastReadRunId', 'is', null),
          eb.not(
            eb.exists(
              eb
                .selectFrom('takeout_run')
                .select('takeout_run.id')
                .whereRef('takeout_run.id', '=', 'takeout_part.lastReadRunId')
                .where('takeout_run.status', 'in', TAKEOUT_RUNNING_RUN_STATUSES),
            ),
          ),
        ]),
      )
      .execute();
  }

  // ---------- entries ----------

  /** ON CONFLICT DO NOTHING: a retried or duplicated flush never inserts a seq twice */
  async insertEntries(rows: Insertable<TakeoutEntryTable>[]) {
    if (rows.length === 0) {
      return;
    }
    await this.db
      .insertInto('takeout_entry')
      .values(rows)
      .onConflict((oc) => oc.columns(['partId', 'seq']).doNothing())
      .execute();
  }

  /** Insert one entry, used by the row-by-row retry after a batch fails */
  async insertEntry(row: Insertable<TakeoutEntryTable>) {
    await this.db
      .insertInto('takeout_entry')
      .values(row)
      .onConflict((oc) => oc.columns(['partId', 'seq']).doNothing())
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteEntriesOfPart(partId: string) {
    await this.db.deleteFrom('takeout_entry').where('partId', '=', partId).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getMaxEntrySeq(partId: string): Promise<number | null> {
    const row = await this.db
      .selectFrom('takeout_entry')
      .select((eb) => eb.fn.max('seq').as('maxSeq'))
      .where('partId', '=', partId)
      .executeTakeFirst();
    return row?.maxSeq === null || row?.maxSeq === undefined ? null : Number(row.maxSeq);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async countEntries(partId: string) {
    const row = await this.db
      .selectFrom('takeout_entry')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('partId', '=', partId)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /** Committed rows of a part, for a tgz resume: seq -> what the entry was */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getEntriesForSkip(partId: string): Promise<Map<number, CachedEntryRow>> {
    const rows = await this.db
      .selectFrom('takeout_entry')
      .select(['seq', 'path', 'size', 'kind', 'checksum'])
      .where('partId', '=', partId)
      .execute();
    return new Map(
      rows.map((row) => [
        row.seq,
        { seq: row.seq, path: row.path, size: Number(row.size), kind: row.kind, checksum: row.checksum },
      ]),
    );
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteEntriesOfExport(exportId: string) {
    await this.db.deleteFrom('takeout_entry').where('exportId', '=', exportId).execute();
  }

  /** Media entry names of the export, for the sample-pruning rule */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getMediaEntryPaths(exportId: string) {
    const rows = await this.db
      .selectFrom('takeout_entry')
      .select('path')
      .where('exportId', '=', exportId)
      .where('kind', '=', TakeoutEntryKind.Media)
      .execute();
    return rows.map((r) => r.path);
  }

  /** Media entries without a sample that may need one (sample backfill) */
  @GenerateSql({ params: [DummyValue.UUID] })
  getEntriesWithoutSample(exportId: string) {
    return this.db
      .selectFrom('takeout_entry')
      .innerJoin('takeout_part', 'takeout_part.id', 'takeout_entry.partId')
      .select([
        'takeout_entry.id as id',
        'takeout_entry.partId as partId',
        'takeout_entry.seq as seq',
        'takeout_entry.path as path',
        'takeout_entry.size as size',
        'takeout_entry.checksum as checksum',
        'takeout_part.fileName as partName',
      ])
      .where('takeout_entry.exportId', '=', exportId)
      .where('takeout_entry.kind', '=', TakeoutEntryKind.Media)
      .where('takeout_entry.sample', 'is', null)
      .where('takeout_entry.sampleSkipped', 'is', null)
      .where('takeout_entry.checksum', 'is not', null)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.NUMBER, {}] })
  async updateEntry(id: number | string, patch: Updateable<TakeoutEntryTable>) {
    await this.db
      .updateTable('takeout_entry')
      .set(patch)
      .where('id', '=', id as any)
      .execute();
  }

  /** Clear samples of entries whose path is not in `keepPaths` (one array parameter, whatever its size) */
  async pruneSamples(exportId: string, keepPaths: string[]) {
    let query = this.db
      .updateTable('takeout_entry')
      .set({ sample: null })
      .where('exportId', '=', exportId)
      .where('sample', 'is not', null);
    if (keepPaths.length > 0) {
      query = query.where(sql<boolean>`NOT ("path" = ANY(${keepPaths}::text[]))`);
    }
    await query.execute();
  }

  /**
   * Entries of the parts whose rows may enter a plan: this catalog version, complete or stopped at a data error,
   * present on disk, and not found missing by the current attempt (single-pass design 7 step 3). Ordered like the
   * old pass-1 catalog (segment, part number, seq) so the planner input is unchanged.
   */
  streamEntriesForExport(exportId: string, options: { catalogVersion: number; excludePartIds?: string[] }) {
    let query = this.db
      .selectFrom('takeout_entry')
      .innerJoin('takeout_part', 'takeout_part.id', 'takeout_entry.partId')
      .select([
        'takeout_entry.id as id',
        'takeout_entry.partId as partId',
        'takeout_entry.seq as seq',
        'takeout_entry.path as path',
        'takeout_entry.size as size',
        'takeout_entry.mtime as mtime',
        'takeout_entry.kind as kind',
        'takeout_entry.checksum as checksum',
        'takeout_entry.json as json',
        'takeout_entry.width as width',
        'takeout_entry.height as height',
        'takeout_entry.sample as sample',
        'takeout_entry.readError as readError',
        'takeout_part.fileName as partName',
        'takeout_part.partNumber as partNumber',
        'takeout_part.segment as segment',
      ])
      .where('takeout_entry.exportId', '=', exportId)
      .where('takeout_part.catalogVersion', '=', options.catalogVersion)
      .where('takeout_part.catalogStatus', 'in', [TakeoutCatalogStatus.Complete, TakeoutCatalogStatus.Error])
      .where('takeout_part.isMissing', '=', false);
    if (options.excludePartIds && options.excludePartIds.length > 0) {
      query = query.where('takeout_part.id', 'not in', options.excludePartIds);
    }
    return query
      .orderBy('takeout_part.segment', sql`asc nulls first`)
      .orderBy('takeout_part.partNumber', 'asc')
      .orderBy('takeout_entry.seq', 'asc')
      .stream();
  }

  /** Paths of the media entries of catalogued parts (sampling set when every part is zip) */
  @GenerateSql({ params: [DummyValue.UUID, 2] })
  async getCataloguedMediaPaths(exportId: string, catalogVersion: number) {
    const rows = await this.db
      .selectFrom('takeout_entry')
      .innerJoin('takeout_part', 'takeout_part.id', 'takeout_entry.partId')
      .select('takeout_entry.path as path')
      .where('takeout_entry.exportId', '=', exportId)
      .where('takeout_entry.kind', '=', TakeoutEntryKind.Media)
      .where('takeout_part.catalogVersion', '=', catalogVersion)
      .where('takeout_part.catalogStatus', '=', TakeoutCatalogStatus.Complete)
      .execute();
    return rows.map((row) => row.path);
  }

  /** Every catalogued occurrence of the checksums, for fetch source ranking */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.BUFFER], 2] })
  async getEntryOccurrences(exportId: string, checksums: Buffer[], catalogVersion: number) {
    if (checksums.length === 0) {
      return [];
    }
    return this.db
      .selectFrom('takeout_entry')
      .innerJoin('takeout_part', 'takeout_part.id', 'takeout_entry.partId')
      .select([
        'takeout_entry.checksum as checksum',
        'takeout_entry.partId as partId',
        'takeout_entry.seq as seq',
        'takeout_entry.path as path',
        'takeout_entry.size as size',
        'takeout_entry.endOffset as endOffset',
        'takeout_part.fileName as partName',
        'takeout_part.kind as kind',
      ])
      .where('takeout_entry.exportId', '=', exportId)
      .where('takeout_entry.checksum', 'in', checksums)
      .where('takeout_part.catalogVersion', '=', catalogVersion)
      .where('takeout_part.catalogStatus', '!=', TakeoutCatalogStatus.None)
      .where('takeout_part.isMissing', '=', false)
      .execute();
  }

  // ---------- server content (the read context) ----------

  /** Checksums of the user's upload assets (library assets excluded, trashed included) */
  streamUploadChecksums(userId: string) {
    return this.db
      .selectFrom('asset')
      .select('checksum')
      .where('ownerId', '=', userId)
      .where('libraryId', 'is', null)
      .stream();
  }

  /** Checksums of permanently deleted assets (deleted re-import mode skip) */
  streamDeletedChecksums(userId: string) {
    return this.db.selectFrom('asset_deleted_checksum').select('checksum').where('ownerId', '=', userId).stream();
  }

  /** Distinct sizes of the user's upload assets above a limit (same predicate as the checksums) */
  @GenerateSql({ params: [DummyValue.UUID, 0] })
  async getUploadAssetSizesOver(userId: string, size: number): Promise<number[]> {
    const rows = await this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select('asset_exif.fileSizeInByte as size')
      .distinct()
      .where('asset.ownerId', '=', userId)
      .where('asset.libraryId', 'is', null)
      .where('asset_exif.fileSizeInByte', '>', size)
      .execute();
    return rows.map((row) => Number(row.size));
  }

  /** Upload assets of one size (at most `limit`), for the large-entry prefix probe */
  @GenerateSql({ params: [DummyValue.UUID, 0, 9] })
  getUploadAssetsBySize(userId: string, size: number, limit: number) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['asset.id as id', 'asset.originalPath as originalPath'])
      .where('asset.ownerId', '=', userId)
      .where('asset.libraryId', 'is', null)
      .where('asset_exif.fileSizeInByte', '=', size)
      .limit(limit)
      .execute();
  }

  // ---------- runs ----------

  @GenerateSql({ params: [{ userId: DummyValue.UUID, exportId: DummyValue.UUID }] })
  createRun(row: Insertable<TakeoutRunTable>) {
    return this.db.insertInto('takeout_run').values(row).returningAll().executeTakeFirstOrThrow();
  }

  /**
   * One transaction (single-pass design 10.4): the previous failed or cancelled run hands its staging to the new run
   * (supersededBy, cancelled, its planned and written rows skipped 'superseded') and the new run is inserted. When the
   * previous run was resumed meanwhile, no adoption happens and the new run is still created.
   */
  async createRunWithAdoption(row: Insertable<TakeoutRunTable>, adoptFromRunId: string | null) {
    return this.db.transaction().execute(async (tx) => {
      const created = await tx.insertInto('takeout_run').values(row).returningAll().executeTakeFirstOrThrow();
      let adopted = false;
      if (adoptFromRunId) {
        const old = await tx
          .updateTable('takeout_run')
          .set({
            supersededBy: created.id,
            status: TakeoutRunStatus.Cancelled,
            hasStaging: false,
            error: `superseded by ${created.id}`,
            leaseToken: null,
            updatedAt: sql`now()`,
          })
          .where('id', '=', adoptFromRunId)
          .where('status', 'in', [TakeoutRunStatus.Failed, TakeoutRunStatus.Cancelled])
          .where('supersededBy', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (old) {
          adopted = true;
          await tx
            .updateTable('takeout_run_file')
            // a target, if one was left (normally none after the cancel or failure cleanup), is kept: the new run
            // reclaims it into its staging
            .set({ status: TakeoutRunFileStatus.Skipped, reason: 'superseded', updatedAt: sql`now()` })
            .where('runId', '=', adoptFromRunId)
            .where('status', 'in', [TakeoutRunFileStatus.Planned, TakeoutRunFileStatus.Written])
            .execute();
        }
      }
      return { run: created, adopted };
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getRun(id: string) {
    return this.db.selectFrom('takeout_run').selectAll().where('id', '=', id).executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getRunsByExport(exportId: string) {
    return this.db
      .selectFrom('takeout_run')
      .selectAll()
      .where('exportId', '=', exportId)
      .orderBy('createdAt', 'desc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getActiveRun(userId: string) {
    return this.db
      .selectFrom('takeout_run')
      .selectAll()
      .where('userId', '=', userId)
      .where('status', 'in', TAKEOUT_ACTIVE_RUN_STATUSES)
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getActiveRunForExport(exportId: string) {
    return this.db
      .selectFrom('takeout_run')
      .selectAll()
      .where('exportId', '=', exportId)
      .where('status', 'in', TAKEOUT_ACTIVE_RUN_STATUSES)
      .executeTakeFirst();
  }

  /** Newest failed or cancelled run of the export that still holds staging and was not adopted yet */
  @GenerateSql({ params: [DummyValue.UUID] })
  getAdoptableRun(exportId: string) {
    return this.db
      .selectFrom('takeout_run')
      .selectAll()
      .where('exportId', '=', exportId)
      .where('status', 'in', [TakeoutRunStatus.Failed, TakeoutRunStatus.Cancelled])
      .where('hasStaging', '=', true)
      .where('supersededBy', 'is', null)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /** The runs this run superseded (their staging directory moves into this run's) */
  @GenerateSql({ params: [DummyValue.UUID] })
  getRunsSupersededBy(runId: string) {
    return this.db.selectFrom('takeout_run').selectAll().where('supersededBy', '=', runId).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, {}] })
  async updateRun(id: string, patch: Updateable<TakeoutRunTable>) {
    await this.db
      .updateTable('takeout_run')
      .set({ ...patch, updatedAt: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  /** Progress and statistics written by the job holding the lease; a stale job writes nothing */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, {}] })
  async updateRunIfLeased(id: string, token: string, patch: Updateable<TakeoutRunTable>) {
    const row = await this.db
      .updateTable('takeout_run')
      .set({ ...patch, updatedAt: sql`now()` })
      .where('id', '=', id)
      .where('leaseToken', '=', token)
      .where('status', 'in', TAKEOUT_RUNNING_RUN_STATUSES)
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  /**
   * Status check-and-set for the job (single-pass design 10.6): only the lease holder moves a running run.
   * No row returned means the lease was lost or the run left the running statuses.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, TakeoutRunStatus.Reading, {}] })
  async setRunStatusCas(
    id: string,
    token: string,
    status: TakeoutRunStatus,
    patch: Updateable<TakeoutRunTable> = {},
  ): Promise<boolean> {
    const row = await this.db
      .updateTable('takeout_run')
      .set({ ...patch, status, updatedAt: sql`now()` })
      .where('id', '=', id)
      .where('leaseToken', '=', token)
      .where('status', 'in', TAKEOUT_RUNNING_RUN_STATUSES)
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  /**
   * Final or intermediate status from one of `from`, releasing the lease. With a token, only the lease holder may
   * do it; without one (API, boot), any caller whose view of the status is still current.
   */
  @GenerateSql({ params: [DummyValue.UUID, [TakeoutRunStatus.Queued], null, TakeoutRunStatus.Cancelled, {}] })
  async finishRunCas(
    id: string,
    from: TakeoutRunStatus[],
    token: string | null,
    status: TakeoutRunStatus,
    patch: Updateable<TakeoutRunTable> = {},
  ): Promise<boolean> {
    let query = this.db
      .updateTable('takeout_run')
      .set({ ...patch, status, leaseToken: null, updatedAt: sql`now()` })
      .where('id', '=', id)
      .where('status', 'in', from);
    if (token !== null) {
      query = query.where('leaseToken', '=', token);
    }
    const row = await query.returning('id').executeTakeFirst();
    return !!row;
  }

  /** Cancel request of the API: a running run becomes cancelling (the job holding the lease cleans up) */
  @GenerateSql({ params: [DummyValue.UUID] })
  async requestCancel(id: string): Promise<boolean> {
    const row = await this.db
      .updateTable('takeout_run')
      .set({ status: TakeoutRunStatus.Cancelling, updatedAt: sql`now()` })
      .where('id', '=', id)
      .where('status', 'in', TAKEOUT_RUNNING_RUN_STATUSES)
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  /** Runs a job may still be working on after a crash (boot recovery), including cancelling ones */
  @GenerateSql()
  getInterruptedRuns() {
    return this.db.selectFrom('takeout_run').selectAll().where('status', 'in', TAKEOUT_ACTIVE_RUN_STATUSES).execute();
  }

  /** Non-final runs of a user, set to cancelling on UserTrash */
  @GenerateSql({ params: [DummyValue.UUID] })
  getActiveRunsByUser(userId: string) {
    return this.db
      .selectFrom('takeout_run')
      .selectAll()
      .where('userId', '=', userId)
      .where('status', 'in', TAKEOUT_ACTIVE_RUN_STATUSES)
      .execute();
  }

  /** Lease CAS: take or renew the lease of a running run unless another live worker holds it */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async takeLease(runId: string, token: string) {
    const row = await this.db
      .updateTable('takeout_run')
      .set({ heartbeatAt: sql`now()`, leaseToken: token })
      .where('id', '=', runId)
      .where('status', 'in', TAKEOUT_RUNNING_RUN_STATUSES)
      .where((eb) =>
        eb.or([
          eb('leaseToken', 'is', null),
          eb('leaseToken', '=', token),
          eb('heartbeatAt', '<', sql.raw<Date>("now() - interval '60 seconds'")),
        ]),
      )
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  /** Resume (single-pass design 10.3): only a failed or cancelled run that was not superseded goes back to queued */
  @GenerateSql({ params: [DummyValue.UUID, 1] })
  async requeueRun(id: string, attempt: number): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .updateTable('takeout_run')
        .set({
          status: TakeoutRunStatus.Queued,
          error: null,
          heartbeatAt: null,
          leaseToken: null,
          finishedAt: null,
          attempt,
          updatedAt: sql`now()`,
        })
        .where('id', '=', id)
        .where('status', 'in', [TakeoutRunStatus.Failed, TakeoutRunStatus.Cancelled])
        .where('supersededBy', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!row) {
        return false;
      }
      // rows a cancel skipped are planned again (their files were reclaimed into staging)
      await tx
        .updateTable('takeout_run_file')
        .set({ status: TakeoutRunFileStatus.Planned, reason: null, targetPath: null, updatedAt: sql`now()` })
        .where('runId', '=', id)
        .where('status', '=', TakeoutRunFileStatus.Skipped)
        .where('reason', '=', 'cancelled')
        .where('action', 'in', [
          TakeoutRunFileAction.Upload,
          TakeoutRunFileAction.ServerDuplicate,
          TakeoutRunFileAction.BetterOnServer,
          TakeoutRunFileAction.AlreadyProcessed,
        ])
        .execute();
      return true;
    });
  }

  /** Sweep claim: a failed or cancelled run past its staging TTL gives up its staging (no row: it was resumed) */
  @GenerateSql({ params: [DummyValue.UUID, 1000] })
  async claimExpiredStaging(runId: string, ttlMs: number): Promise<boolean> {
    const row = await this.db
      .updateTable('takeout_run')
      .set({ hasStaging: false, updatedAt: sql`now()` })
      .where('id', '=', runId)
      .where('status', 'in', [TakeoutRunStatus.Failed, TakeoutRunStatus.Cancelled])
      .where('finishedAt', '<', sql<Date>`now() - ${`${Math.floor(ttlMs)} milliseconds`}::interval`)
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  /** Failed or cancelled runs that still hold files under upload/ (boot reclaim) */
  @GenerateSql()
  getStoppedRunsWithTargets() {
    return this.db
      .selectFrom('takeout_run')
      .selectAll()
      .where('status', 'in', [TakeoutRunStatus.Failed, TakeoutRunStatus.Cancelled])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('takeout_run_file')
            .select('takeout_run_file.id')
            .whereRef('takeout_run_file.runId', '=', 'takeout_run.id')
            .where('takeout_run_file.targetPath', 'is not', null)
            .where('takeout_run_file.status', 'in', [
              TakeoutRunFileStatus.Planned,
              TakeoutRunFileStatus.Written,
              TakeoutRunFileStatus.Error,
            ]),
        ),
      )
      .execute();
  }

  // ---------- run files ----------

  /**
   * The planning transaction (single-pass design 7 step 5): the lease check-and-set to the next status, the plan and
   * report rows in chunks, and the export's post-read analysis. All or nothing, so "skip planning when rows exist"
   * is safe. Returns false (and writes nothing) when the lease was lost.
   */
  async commitPlan(input: {
    runId: string;
    token: string;
    rows: Insertable<TakeoutRunFileTable>[];
    nextStatus: TakeoutRunStatus;
    runPatch: Updateable<TakeoutRunTable>;
    exportId: string;
    exportPatch: Updateable<TakeoutExportTable>;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const run = await tx
        .updateTable('takeout_run')
        .set({ ...input.runPatch, status: input.nextStatus, updatedAt: sql`now()` })
        .where('id', '=', input.runId)
        .where('leaseToken', '=', input.token)
        .where('status', '=', TakeoutRunStatus.Planning)
        .returning('id')
        .executeTakeFirst();
      if (!run) {
        return false;
      }
      for (let i = 0; i < input.rows.length; i += RUN_FILE_INSERT_CHUNK) {
        await tx
          .insertInto('takeout_run_file')
          .values(input.rows.slice(i, i + RUN_FILE_INSERT_CHUNK))
          .onConflict((oc) => oc.columns(['runId', 'seq']).doNothing())
          .execute();
      }
      await tx
        .updateTable('takeout_export')
        .set({ ...input.exportPatch, updatedAt: sql`now()` })
        .where('id', '=', input.exportId)
        .execute();
      return true;
    });
  }

  /** Plain chunked insert (tests and tools); the run job uses commitPlan */
  async insertRunFiles(rows: Insertable<TakeoutRunFileTable>[]) {
    for (let i = 0; i < rows.length; i += RUN_FILE_INSERT_CHUNK) {
      await this.db
        .insertInto('takeout_run_file')
        .values(rows.slice(i, i + RUN_FILE_INSERT_CHUNK))
        .onConflict((oc) => oc.columns(['runId', 'seq']).doNothing())
        .execute();
    }
  }

  @GenerateSql({ params: [DummyValue.NUMBER, {}] })
  async updateRunFile(id: number | string, patch: Updateable<TakeoutRunFileTable>) {
    await this.db
      .updateTable('takeout_run_file')
      .set({ ...patch, updatedAt: sql`now()` })
      .where('id', '=', id as any)
      .execute();
  }

  /** Rows of a run in a status move to another (cancel: planned -> skipped 'cancelled') */
  @GenerateSql({
    params: [DummyValue.UUID, [TakeoutRunFileStatus.Planned], { status: TakeoutRunFileStatus.Skipped }],
  })
  async updateRunFilesByStatus(
    runId: string,
    statuses: TakeoutRunFileStatus[],
    patch: Updateable<TakeoutRunFileTable>,
  ) {
    await this.db
      .updateTable('takeout_run_file')
      .set({ ...patch, updatedAt: sql`now()` })
      .where('runId', '=', runId)
      .where('status', 'in', statuses)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getRunFilesForImport(runId: string) {
    return this.db
      .selectFrom('takeout_run_file')
      .selectAll()
      .where('runId', '=', runId)
      .orderBy('seq', 'asc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async countRunFiles(runId: string) {
    const row = await this.db
      .selectFrom('takeout_run_file')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('runId', '=', runId)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  @GenerateSql({ params: [DummyValue.UUID, TakeoutRunFileStatus.Created] })
  async countRunFilesByStatus(runId: string, status: TakeoutRunFileStatus) {
    const row = await this.db
      .selectFrom('takeout_run_file')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('runId', '=', runId)
      .where('status', '=', status)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async getRunFilesPage(
    runId: string,
    filter: { action?: string; status?: string; search?: string },
    page: number,
    size: number,
  ) {
    let query = this.db.selectFrom('takeout_run_file').where('runId', '=', runId);
    if (filter.action) {
      query = query.where('action', '=', filter.action as any);
    }
    if (filter.status) {
      query = query.where('status', '=', filter.status as any);
    }
    if (filter.search) {
      query = query.where('takeoutPath', 'ilike', `%${filter.search}%`);
    }

    const totalRow = await query.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirst();
    const total = Number(totalRow?.count ?? 0);

    const items = await query
      .selectAll()
      .orderBy('seq', 'asc')
      .limit(size)
      .offset((page - 1) * size)
      .execute();

    return { items, total };
  }

  /** Stream the report rows for the CSV download */
  streamRunFiles(runId: string) {
    return this.db.selectFrom('takeout_run_file').selectAll().where('runId', '=', runId).orderBy('seq', 'asc').stream();
  }

  /** Grouped rows for countersFromRows */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getCounterRows(runId: string): Promise<CounterRowResult[]> {
    const rows = await this.db
      .selectFrom('takeout_run_file')
      .select((eb) => [
        'action',
        'status',
        'fileKind',
        'matcher',
        'fallbacks',
        'rotationState',
        'isCover',
        'groupKind',
        'reason',
        eb.fn.countAll<number>().as('count'),
      ])
      .where('runId', '=', runId)
      .groupBy([
        'action',
        'status',
        'fileKind',
        'matcher',
        'fallbacks',
        'rotationState',
        'isCover',
        'groupKind',
        'reason',
      ])
      .execute();
    return rows.map((r) => ({
      action: r.action,
      status: r.status,
      fileKind: r.fileKind,
      matcher: r.matcher,
      fallbacks: r.fallbacks ?? [],
      rotationState: r.rotationState,
      isCover: r.isCover,
      groupKind: r.groupKind,
      reason: r.reason,
      count: Number(r.count),
    }));
  }

  /** Rotation-state counts overlaid on read (2.9) */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getRotationCounts(runId: string) {
    const rows = await this.db
      .selectFrom('takeout_run_file')
      .select((eb) => ['rotationState', eb.fn.countAll<number>().as('count')])
      .where('runId', '=', runId)
      .where('rotationState', 'is not', null)
      .groupBy('rotationState')
      .execute();
    const counts: Record<string, number> = {};
    for (const r of rows) {
      if (r.rotationState) {
        counts[r.rotationState] = Number(r.count);
      }
    }
    return counts;
  }

  /** Rows of a run that point at a file under upload/ (reclaim, single-pass design 5.4) */
  @GenerateSql({ params: [DummyValue.UUID] })
  getRunFilesWithTarget(runId: string) {
    return this.db
      .selectFrom('takeout_run_file')
      .select(['id', 'seq', 'action', 'status', 'targetPath', 'newAssetId', 'size', 'checksum', 'entrySeq'])
      .where('runId', '=', runId)
      .where('targetPath', 'is not', null)
      .execute();
  }

  // ---------- rotation hook ----------

  @GenerateSql({ params: [DummyValue.UUID] })
  getPendingRotations(assetId: string) {
    return this.db
      .selectFrom('takeout_run_file')
      .select(['id', 'rotation'])
      .where('assetId', '=', assetId)
      .where('rotationState', '=', TakeoutRotationState.Pending)
      .execute();
  }

  // ---------- larger versions ----------

  @GenerateSql({
    params: [{ userId: DummyValue.UUID, largerAssetId: DummyValue.UUID, smallerAssetId: DummyValue.UUID }],
  })
  async insertLargerVersion(row: Insertable<TakeoutLargerVersionTable>) {
    await this.db
      .insertInto('takeout_larger_version')
      .values(row)
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getLargerVersion(id: string) {
    return this.db.selectFrom('takeout_larger_version').selectAll().where('id', '=', id).executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getLargerVersions(userId: string, status?: 'pending' | 'resolved') {
    let query = this.db
      .selectFrom('takeout_larger_version')
      .selectAll()
      .where('userId', '=', userId)
      .orderBy('createdAt', 'desc');
    if (status === 'pending') {
      query = query.where('status', '=', TakeoutLargerVersionStatus.Pending);
    } else if (status === 'resolved') {
      query = query.where('status', '!=', TakeoutLargerVersionStatus.Pending);
    }
    return query.execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async countPendingLargerVersions(userId: string) {
    const row = await this.db
      .selectFrom('takeout_larger_version')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('userId', '=', userId)
      .where('status', '=', TakeoutLargerVersionStatus.Pending)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  @GenerateSql({ params: [DummyValue.UUID, {}] })
  async updateLargerVersion(id: string, patch: Updateable<TakeoutLargerVersionTable>) {
    await this.db.updateTable('takeout_larger_version').set(patch).where('id', '=', id).execute();
  }

  // ---------- server pre-check (checksums, name/time) ----------

  /** Non-library assets of the owner with any of the checksums, trashed included */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.BUFFER]] })
  async getUploadAssetsByChecksums(userId: string, checksums: Buffer[]) {
    if (checksums.length === 0) {
      return [];
    }
    return this.db
      .selectFrom('asset')
      .select(['id', 'checksum', 'deletedAt', 'originalPath'])
      .where('ownerId', '=', userId)
      .where('libraryId', 'is', null)
      .where('checksum', 'in', checksums)
      .execute();
  }

  /** Stream the owner's non-library assets created before the run, for the name/time map (DEV 5) */
  streamAssetsForNameMatch(userId: string, before: Date) {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id as id',
        'asset.originalFileName as originalFileName',
        sql<Date | null>`coalesce("asset_exif"."dateTimeOriginal", "asset"."fileCreatedAt")`.as('at'),
        'asset_exif.fileSizeInByte as fileSizeInByte',
        'asset.checksum as checksum',
      ])
      .where('asset.ownerId', '=', userId)
      .where('asset.libraryId', 'is', null)
      .where('asset.deletedAt', 'is', null)
      .where('asset.createdAt', '<', before)
      .orderBy('asset.id', 'asc')
      .stream();
  }

  /**
   * Finding T9/#9 (section 12 IMMICH MECHANICS): the per-asset post-import state used to verify that the metadata /
   * thumbnail / video-conversion jobs actually ran, and to re-queue the ones that silently did not. `metadataDone`
   * comes from asset_job_status, the thumbnail from the asset's thumbhash plus its preview/thumbnail files, and the
   * encoded video from an encoded_video file (videos only).
   */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async getPostImportState(assetIds: string[]) {
    if (assetIds.length === 0) {
      return [];
    }
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
      .select((eb) => {
        const file = (type: AssetFileType) =>
          eb
            .selectFrom('asset_file')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', sql.lit(type));
        return [
          'asset.id as id',
          'asset.type as type',
          eb('asset.thumbhash', 'is not', null).as('hasThumbhash'),
          eb('asset_job_status.metadataExtractedAt', 'is not', null).as('metadataDone'),
          eb.exists(file(AssetFileType.Preview)).as('hasPreview'),
          eb.exists(file(AssetFileType.Thumbnail)).as('hasThumbnail'),
          eb.exists(file(AssetFileType.EncodedVideo)).as('hasEncodedVideo'),
        ];
      })
      .where('asset.id', 'in', assetIds)
      .where('asset.deletedAt', 'is', null)
      .execute();
  }
}
