import { createPostgres, DatabaseConnectionParams, schemaDiff, schemaFromDatabase } from '@immich/sql-tools';
import { Kysely, Migrator, sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import {
  TakeoutArchiveKind,
  TakeoutCatalogStatus,
  TakeoutEntryKind,
  TakeoutFileKind,
  TakeoutRunFileAction,
  TakeoutRunFileStatus,
  TakeoutRunStatus,
} from 'src/enum';
import { ConfigRepository } from 'src/repositories/config.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { TakeoutRepository } from 'src/repositories/takeout.repository';
import { DB } from 'src/schema';
import { BaseService } from 'src/services/base.service';
import { getKyselyConfig } from 'src/utils/database';
import { CompositeMigrationProvider, migrationFolders } from 'src/utils/migration';
import { newMediumService } from 'test/medium.factory';
import { getKyselyDB } from 'test/utils';

// single-pass design 17.3: the migration matrix, the chunked plan insert and the check-and-set queries

const SHIPPED = '1790600000000-TakeoutImport';
const SINGLE_PASS = '1790700000000-TakeoutSinglePass';

let defaultDatabase: Kysely<DB>;
const databases: Kysely<DB>[] = [];

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

afterAll(async () => {
  await Promise.all(databases.map((db) => db.destroy()));
});

const newEmptyDatabase = async () => {
  const testUrl = process.env.IMMICH_TEST_POSTGRES_URL!;
  const adminUrl = testUrl.replace(/\/[^/]+$/, '/postgres');
  const admin = createPostgres({ maxConnections: 1, connection: { connectionType: 'url', url: adminUrl } });
  const name = `immich_takeout_${Math.random().toString(36).slice(2, 7)}`;
  await admin.unsafe(`CREATE DATABASE ${name} OWNER postgres;`);
  await admin.end();
  const url = testUrl.replace(/\/[^/]+$/, () => `/${name}`);
  const db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url }));
  databases.push(db);
  return { db, url };
};

const newMigrator = (db: Kysely<DB>) =>
  new Migrator({
    db,
    migrationLockTableName: 'kysely_migrations_lock',
    allowUnorderedMigrations: true,
    migrationTableName: 'kysely_migrations',
    provider: new CompositeMigrationProvider(migrationFolders),
  });

const takeoutTables = async (url: string) => {
  const schema = await schemaFromDatabase({ connection: { connectionType: 'url', url } });
  return { ...schema, tables: schema.tables.filter((table) => table.name.startsWith('takeout_')) };
};

const drift = (db: Kysely<DB>, url: string) => {
  const connection: DatabaseConnectionParams = { connectionType: 'url', url };
  const config = { getEnv: () => ({ database: { config: connection } }) } as unknown as ConfigRepository;
  return new DatabaseRepository(db, LoggingRepository.create(), config).getSchemaDrift();
};

const rows = async <T = any>(db: Kysely<any>, query: ReturnType<typeof sql>) => {
  const result = await query.execute(db);
  return result.rows as T[];
};

const migrated = async (step: Promise<{ error?: unknown }>) => {
  const { error } = await step;
  return error;
};

describe('migration 1790700000000-TakeoutSinglePass', () => {
  it('maps old-shape rows, has no drift, and down() restores the shipped shape', async () => {
    const { db, url } = await newEmptyDatabase();
    const migrator = newMigrator(db);
    expect(await migrated(migrator.migrateTo(SHIPPED))).toBeUndefined();
    const shipped = await takeoutTables(url);

    const [group] = await rows(db, sql`INSERT INTO cluster_group (name) VALUES ('g') RETURNING id`);
    const [user] = await rows(
      db,
      sql`INSERT INTO "user" (email, name, "clusterGroupId") VALUES ('m@example.com', 'M', ${group.id}) RETURNING id`,
    );
    const [exp] = await rows(
      db,
      sql`INSERT INTO takeout_export ("userId", "exportKey", "exportedAt", "scanStatus", analysis, completeness, "analyzedAt")
        VALUES (${user.id}, 'live', now(), 'scanning', '{"reasons":["not_scanned"]}', 'uncertain', now()) RETURNING id`,
    );
    const [archived] = await rows(
      db,
      sql`INSERT INTO takeout_export ("userId", "exportKey", "exportedAt", analysis, completeness, "archivesDeletedAt")
        VALUES (${user.id}, 'archived', now(), '{"reasons":["not_scanned"]}', 'complete', now()) RETURNING id`,
    );
    const [scanned] = await rows(
      db,
      sql`INSERT INTO takeout_part ("exportId", "userId", "fileName", timestamp, "partNumber", kind, size, mtime, ctime, "scanStatus", "entryCount")
        VALUES (${exp.id}, ${user.id}, 'takeout-1-001.tgz', 't', 1, 'tgz', 100, now(), now(), 'scanned', 3) RETURNING id`,
    );
    await sql`INSERT INTO takeout_part ("exportId", "userId", "fileName", timestamp, "partNumber", kind, size, mtime, ctime, "scanStatus")
      VALUES (${exp.id}, ${user.id}, 'takeout-1-002.tgz', 't', 2, 'tgz', 100, now(), now(), 'missing')`.execute(db);
    await sql`INSERT INTO takeout_entry ("exportId", "partId", seq, path, size, kind)
      VALUES (${exp.id}, ${scanned.id}, 0, 'a', 1, 'media')`.execute(db);
    const runs: Record<string, string> = {};
    for (const status of ['queued', 'scanning', 'planning', 'importing', 'finishing', 'cancelling', 'completed']) {
      const [run] = await rows(
        db,
        sql`INSERT INTO takeout_run ("userId", "exportId", status, settings, "templateVars", "leaseToken")
          VALUES (${user.id}, ${exp.id}, ${status}, '{}', '{}', gen_random_uuid()) RETURNING id`,
      );
      runs[status] = run.id;
    }
    await sql`INSERT INTO takeout_run_file ("runId", seq, "takeoutPath", size, "fileKind", action, status, "targetPath")
      VALUES (${runs.importing}, 0, 'a.jpg', 10, 'image', 'upload', 'written', '/upload/a.jpg'),
             (${runs.completed}, 0, 'c.jpg', 10, 'image', 'upload', 'done', null)`.execute(db);

    expect(await migrated(migrator.migrateTo(SINGLE_PASS))).toBeUndefined();

    await expect(rows(db, sql`SELECT count(*)::int AS n FROM takeout_entry`)).resolves.toEqual([{ n: 0 }]);
    await expect(
      rows(db, sql`SELECT "isMissing", "catalogStatus", "entryCount" FROM takeout_part ORDER BY "partNumber"`),
    ).resolves.toEqual([
      { isMissing: false, catalogStatus: 'none', entryCount: null },
      { isMissing: true, catalogStatus: 'none', entryCount: null },
    ]);
    const exports = await rows(db, sql`SELECT id, analysis, completeness, "analyzedAt" FROM takeout_export`);
    expect(exports.find((e) => e.id === exp.id)).toMatchObject({
      analysis: {},
      completeness: 'unknown',
      analyzedAt: null,
    });
    expect(exports.find((e) => e.id === archived.id)!.analysis).toEqual({ reasons: ['not_scanned'] });
    const runRows = await rows(db, sql`SELECT id, status, "leaseToken", error FROM takeout_run`);
    const statuses = Object.fromEntries(runRows.map((r) => [r.id, r]));
    expect(statuses[runs.queued]).toMatchObject({ status: 'queued' });
    expect(statuses[runs.queued].leaseToken).not.toBeNull();
    expect(statuses[runs.scanning]).toMatchObject({ status: 'queued', leaseToken: null });
    expect(statuses[runs.planning]).toMatchObject({ status: 'queued', leaseToken: null });
    expect(statuses[runs.importing].status).toBe('failed');
    expect(statuses[runs.importing].error).toMatch(/Resume to finish/);
    expect(statuses[runs.finishing].status).toBe('failed');
    expect(statuses[runs.cancelling].status).toBe('cancelling');
    expect(statuses[runs.completed].status).toBe('completed');
    await expect(rows(db, sql`SELECT count(*)::int AS n FROM takeout_run_file`)).resolves.toEqual([{ n: 2 }]);

    const afterUp = await drift(db, url);
    expect(afterUp.asHuman()).toEqual([]);

    await sql`INSERT INTO takeout_run_file ("runId", seq, "takeoutPath", size, "fileKind", action, status)
      VALUES (${runs.completed}, 9, 'gone.jpg', 0, 'other', 'missingFromArchive', 'skipped')`.execute(db);
    expect(await migrated(migrator.migrateDown())).toBeUndefined();
    const reverted = await takeoutTables(url);
    const shape = schemaDiff(shipped, reverted, {
      tables: { ignoreExtra: false },
      columns: { ignoreExtra: false },
      constraints: { ignoreExtra: false },
      indexes: { ignoreExtra: false },
      triggers: { ignoreExtra: true },
      functions: { ignoreExtra: true },
      parameters: { ignoreExtra: true },
      extensions: { ignoreExtra: true },
    });
    expect(shape.asSql()).toEqual([]);
    await expect(rows(db, sql`SELECT action FROM takeout_run_file WHERE "takeoutPath" = 'gone.jpg'`)).resolves.toEqual([
      { action: 'partUnreadable' },
    ]);
    await expect(
      rows(db, sql`SELECT "scanStatus" FROM takeout_part WHERE "fileName" = 'takeout-1-002.tgz'`),
    ).resolves.toEqual([{ scanStatus: 'missing' }]);

    expect(await migrated(migrator.migrateTo(SINGLE_PASS))).toBeUndefined();
    const again = await drift(db, url);
    expect(again.asHuman()).toEqual([]);
  });
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database: defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: new TakeoutRepository(defaultDatabase) };
};

const planRow = (runId: string, seq: number) => ({
  runId,
  seq,
  takeoutPath: `Takeout/Google Photos/${seq}.jpg`,
  partName: 'p',
  entrySeq: seq,
  size: 1,
  mtime: null,
  checksum: randomBytes(20),
  fileKind: TakeoutFileKind.Image,
  jsonPath: null,
  matcher: null,
  originalFileName: `${seq}.jpg`,
  groupIndex: seq,
  groupOrder: 0,
  groupKind: null,
  isCover: true,
  action: TakeoutRunFileAction.Upload,
  status: TakeoutRunFileStatus.Planned,
  reason: null,
  plan: { tags: [] },
  dependsOnSeq: null,
  rotation: 0,
  captureDate: null,
  assetId: null,
  smallerAssetId: null,
});

const entry = (exportId: string, partId: string, seq: number, extra: Record<string, unknown> = {}) => ({
  exportId,
  partId,
  seq,
  path: `Takeout/Google Photos/${seq}.jpg`,
  size: 1,
  mtime: null,
  kind: TakeoutEntryKind.Media,
  checksum: randomBytes(20),
  ...extra,
});

const seed = async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const exp = await sut.createExport({
    userId: user.id,
    exportKey: `k-${randomBytes(4).toString('hex')}`,
    exportedAt: new Date(),
  });
  const part = await sut.createPart({
    exportId: exp.id,
    userId: user.id,
    fileName: `takeout-${randomBytes(4).toString('hex')}-001.tgz`,
    timestamp: 't',
    segment: 1,
    partNumber: 1,
    kind: TakeoutArchiveKind.Tgz,
    size: 100,
    mtime: new Date(),
    ctime: new Date(),
  });
  const newRun = (status = TakeoutRunStatus.Queued, extra: Record<string, unknown> = {}) =>
    sut.createRun({ userId: user.id, exportId: exp.id, status, settings: {}, templateVars: {}, ...extra });
  return { ctx, sut, user, exp, part, newRun };
};

describe(TakeoutRepository.name, () => {
  describe('commitPlan', () => {
    it('inserts a 10,000 and a 100,000 row plan in one transaction (F15)', async () => {
      for (const count of [10_000, 100_000]) {
        const { sut, exp, newRun } = await seed();
        const run = await newRun(TakeoutRunStatus.Planning, { leaseToken: 'b0000000-0000-4000-8000-000000000001' });
        const plan = Array.from({ length: count }, (_, seq) => planRow(run.id, seq));
        const ok = await sut.commitPlan({
          runId: run.id,
          token: 'b0000000-0000-4000-8000-000000000001',
          rows: plan,
          nextStatus: TakeoutRunStatus.Importing,
          runPatch: { bytesTotal: count },
          exportId: exp.id,
          exportPatch: { completeness: 'complete' as any },
        });
        expect(ok).toBe(true);
        await expect(sut.countRunFiles(run.id)).resolves.toBe(count);
        await expect(sut.getRun(run.id)).resolves.toMatchObject({ status: TakeoutRunStatus.Importing });
      }
    }, 120_000);

    it('writes nothing when the lease was lost', async () => {
      const { sut, exp, newRun } = await seed();
      const run = await newRun(TakeoutRunStatus.Planning, { leaseToken: 'b0000000-0000-4000-8000-000000000002' });
      const ok = await sut.commitPlan({
        runId: run.id,
        token: 'b0000000-0000-4000-8000-000000000003',
        rows: [planRow(run.id, 0)],
        nextStatus: TakeoutRunStatus.Importing,
        runPatch: {},
        exportId: exp.id,
        exportPatch: {},
      });
      expect(ok).toBe(false);
      await expect(sut.countRunFiles(run.id)).resolves.toBe(0);
    });
  });

  describe('run check-and-set', () => {
    it('never leases a run in a final status, and moves a status only with the lease (I10)', async () => {
      const { sut, newRun } = await seed();
      for (const status of [TakeoutRunStatus.Failed, TakeoutRunStatus.Cancelled, TakeoutRunStatus.Completed]) {
        const run = await newRun(status);
        await expect(sut.takeLease(run.id, 'b0000000-0000-4000-8000-000000000004')).resolves.toBe(false);
      }
      const run = await newRun();
      const token = 'b0000000-0000-4000-8000-000000000005';
      await expect(sut.takeLease(run.id, token)).resolves.toBe(true);
      await expect(
        sut.setRunStatusCas(run.id, 'b0000000-0000-4000-8000-000000000006', TakeoutRunStatus.Reading),
      ).resolves.toBe(false);
      await expect(sut.setRunStatusCas(run.id, token, TakeoutRunStatus.Reading)).resolves.toBe(true);
      await expect(sut.requestCancel(run.id)).resolves.toBe(true);
      await expect(sut.setRunStatusCas(run.id, token, TakeoutRunStatus.Planning)).resolves.toBe(false);
      await expect(
        sut.finishRunCas(run.id, [TakeoutRunStatus.Cancelling], null, TakeoutRunStatus.Cancelled),
      ).resolves.toBe(true);
      await expect(sut.getRun(run.id)).resolves.toMatchObject({ status: 'cancelled', leaseToken: null });
    });

    it('resumes a cancelled run with its skipped rows planned again, never a superseded one (F19)', async () => {
      const { sut, newRun } = await seed();
      const run = await newRun(TakeoutRunStatus.Cancelled);
      await sut.insertRunFiles([
        { ...planRow(run.id, 0), status: TakeoutRunFileStatus.Skipped, reason: 'cancelled' },
        {
          ...planRow(run.id, 1),
          action: TakeoutRunFileAction.Useless,
          status: TakeoutRunFileStatus.Skipped,
          reason: 'useless',
        },
      ]);
      await expect(sut.requeueRun(run.id, 1)).resolves.toBe(true);
      const files = await sut.getRunFilesForImport(run.id);
      expect(files.map((f) => f.status)).toEqual([TakeoutRunFileStatus.Planned, TakeoutRunFileStatus.Skipped]);
      await expect(sut.requeueRun(run.id, 2)).resolves.toBe(false);

      const successor = await newRun();
      const superseded = await newRun(TakeoutRunStatus.Failed, { supersededBy: successor.id });
      await expect(sut.requeueRun(superseded.id, 1)).resolves.toBe(false);
    });

    it('adopts in one transaction, once', async () => {
      const { sut, user, exp, newRun } = await seed();
      const old = await newRun(TakeoutRunStatus.Failed, { hasStaging: true });
      await sut.insertRunFiles([planRow(old.id, 0)]);
      const first = await sut.createRunWithAdoption(
        { userId: user.id, exportId: exp.id, settings: {}, templateVars: {} },
        old.id,
      );
      expect(first.adopted).toBe(true);
      await expect(sut.getRun(old.id)).resolves.toMatchObject({
        status: TakeoutRunStatus.Cancelled,
        supersededBy: first.run.id,
        hasStaging: false,
      });
      await expect(sut.getRunFilesForImport(old.id)).resolves.toMatchObject([
        { status: TakeoutRunFileStatus.Skipped, reason: 'superseded' },
      ]);
      const second = await sut.createRunWithAdoption(
        { userId: user.id, exportId: exp.id, settings: {}, templateVars: {} },
        old.id,
      );
      expect(second.adopted).toBe(false);
    });

    it('claims expired staging with a check-and-set', async () => {
      const { sut, newRun } = await seed();
      const week = 7 * 24 * 3_600_000;
      const recent = await newRun(TakeoutRunStatus.Failed, { hasStaging: true, finishedAt: new Date() });
      const expired = await newRun(TakeoutRunStatus.Failed, {
        hasStaging: true,
        finishedAt: new Date(Date.now() - week - 3_600_000),
      });
      const resumed = await newRun(TakeoutRunStatus.Queued, {
        hasStaging: true,
        finishedAt: new Date(Date.now() - week - 3_600_000),
      });
      await expect(sut.claimExpiredStaging(recent.id, week)).resolves.toBe(false);
      await expect(sut.claimExpiredStaging(expired.id, week)).resolves.toBe(true);
      await expect(sut.claimExpiredStaging(resumed.id, week)).resolves.toBe(false);
      await expect(sut.getRun(expired.id)).resolves.toMatchObject({ hasStaging: false, status: 'failed' });
    });
  });

  describe('entries', () => {
    it('ignores a duplicated seq and counts the rows of the part when it completes', async () => {
      const { sut, exp, part } = await seed();
      await sut.insertEntries([entry(exp.id, part.id, 0), entry(exp.id, part.id, 1)]);
      await sut.insertEntries([entry(exp.id, part.id, 1, { path: 'dup' })]);
      await sut.completePart(part.id, [entry(exp.id, part.id, 2), entry(exp.id, part.id, 0)], { bytesRead: 100 });
      await expect(sut.getPart(part.id)).resolves.toMatchObject({
        catalogStatus: TakeoutCatalogStatus.Complete,
        entryCount: 3,
      });
      await expect(sut.getMaxEntrySeq(part.id)).resolves.toBe(2);
    });

    it('streams only rows of complete or failed parts of this catalog version that are present', async () => {
      const { sut, exp, part, user } = await seed();
      const other = await sut.createPart({
        exportId: exp.id,
        userId: user.id,
        fileName: `takeout-${randomBytes(4).toString('hex')}-002.tgz`,
        timestamp: 't',
        segment: 1,
        partNumber: 2,
        kind: TakeoutArchiveKind.Tgz,
        size: 100,
        mtime: new Date(),
        ctime: new Date(),
      });
      await sut.insertEntries([entry(exp.id, part.id, 0), entry(exp.id, other.id, 0)]);
      const read = async (excludePartIds: string[] = []) => {
        const out: string[] = [];
        for await (const row of sut.streamEntriesForExport(exp.id, { catalogVersion: 2, excludePartIds })) {
          out.push(row.partId);
        }
        return out;
      };
      await expect(read()).resolves.toEqual([]);
      await sut.updatePart(part.id, { catalogStatus: TakeoutCatalogStatus.Complete, catalogVersion: 2 });
      await sut.updatePart(other.id, { catalogStatus: TakeoutCatalogStatus.Error, catalogVersion: 1 });
      await expect(read()).resolves.toEqual([part.id]);
      await sut.updatePart(other.id, { catalogVersion: 2 });
      await expect(read()).resolves.toEqual([part.id, other.id]);
      await expect(read([other.id])).resolves.toEqual([part.id]);
      await sut.updatePart(part.id, { isMissing: true });
      await expect(read()).resolves.toEqual([other.id]);
    });

    it('prunes samples with any number of kept paths (one array parameter)', async () => {
      const { sut, exp, part } = await seed();
      await sut.insertEntries([
        entry(exp.id, part.id, 0, { sample: Buffer.alloc(4) }),
        entry(exp.id, part.id, 1, { sample: Buffer.alloc(4) }),
      ]);
      const keep = Array.from({ length: 70_000 }, (_, i) => `keep/${i}`);
      keep.push('Takeout/Google Photos/1.jpg');
      await sut.pruneSamples(exp.id, keep);
      const rowsLeft = await rows(
        defaultDatabase,
        sql`SELECT seq, sample IS NOT NULL AS "hasSample" FROM takeout_entry WHERE "partId" = ${part.id} ORDER BY seq`,
      );
      expect(rowsLeft).toEqual([
        { seq: 0, hasSample: false },
        { seq: 1, hasSample: true },
      ]);
    });

    it('resets parts left reading by a run that is not running', async () => {
      const { sut, part, newRun } = await seed();
      const stopped = await newRun(TakeoutRunStatus.Failed);
      await sut.updatePart(part.id, { catalogStatus: TakeoutCatalogStatus.Reading, lastReadRunId: stopped.id });
      await sut.resetReadingParts();
      await expect(sut.getPart(part.id)).resolves.toMatchObject({ catalogStatus: TakeoutCatalogStatus.Partial });

      const running = await newRun(TakeoutRunStatus.Reading);
      await sut.updatePart(part.id, { catalogStatus: TakeoutCatalogStatus.Reading, lastReadRunId: running.id });
      await sut.resetReadingParts();
      await expect(sut.getPart(part.id)).resolves.toMatchObject({ catalogStatus: TakeoutCatalogStatus.Reading });
    });

    it('lists stopped runs that still hold files under upload/', async () => {
      const { sut, newRun } = await seed();
      const holding = await newRun(TakeoutRunStatus.Failed);
      await sut.insertRunFiles([{ ...planRow(holding.id, 0), targetPath: '/upload/x.jpg' } as any]);
      const clean = await newRun(TakeoutRunStatus.Failed);
      await sut.insertRunFiles([planRow(clean.id, 0)]);
      const stopped = await sut.getStoppedRunsWithTargets();
      const found = stopped.map((run) => run.id);
      expect(found).toContain(holding.id);
      expect(found).not.toContain(clean.id);
    });
  });
});
