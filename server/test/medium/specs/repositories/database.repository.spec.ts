import { createPostgres, DatabaseConnectionParams } from '@immich/sql-tools';
import { Kysely, Migrator } from 'kysely';
import { join } from 'node:path';
import { ConfigRepository } from 'src/repositories/config.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { DB } from 'src/schema';
import { getKyselyConfig } from 'src/utils/database';
import {
  CompositeMigrationProvider,
  listMigrationFiles,
  migrationFolders,
  migrationName,
  upstreamMigrationFolder,
} from 'src/utils/migration';

// eslint-disable-next-line unicorn/prefer-module
const sampleFolder = join(__dirname, '..', '..', '..', 'fixtures', 'migrations-aero');
const sampleMigration = '1760000000000-AeroSampleTable';

const databases: Kysely<DB>[] = [];

// an empty database (no template): the migrations have to build everything themselves
const newEmptyDatabase = async () => {
  const testUrl = process.env.IMMICH_TEST_POSTGRES_URL!;
  const adminUrl = testUrl.replace(/\/[^/]+$/, '/postgres');
  const admin = createPostgres({ maxConnections: 1, connection: { connectionType: 'url', url: adminUrl } });
  const name = `immich_migrations_${Math.random().toString(36).slice(2, 7)}`;
  await admin.unsafe(`CREATE DATABASE ${name} OWNER postgres;`);
  await admin.end();

  const url = testUrl.replace(/\/[^/]+$/, () => `/${name}`);
  const db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url }));
  databases.push(db);
  return { db, url };
};

const newMigrator = (db: Kysely<DB>, folders: string[], allowUnorderedMigrations = true) =>
  new Migrator({
    db,
    migrationLockTableName: 'kysely_migrations_lock',
    allowUnorderedMigrations,
    migrationTableName: 'kysely_migrations',
    provider: new CompositeMigrationProvider(folders),
  });

const appliedNames = async (db: Kysely<DB>) => {
  const rows = await db.selectFrom('kysely_migrations').select('name').orderBy('name', 'asc').execute();
  return rows.map((row) => row.name);
};

const expectedNames = async (folders: string[]) => {
  const names: string[] = [];
  for (const folder of folders) {
    for (const file of await listMigrationFiles(folder)) {
      names.push(migrationName(file));
    }
  }
  return names.toSorted();
};

const newRepository = (db: Kysely<DB>, url: string) => {
  const connection: DatabaseConnectionParams = { connectionType: 'url', url };
  const configRepository = { getEnv: () => ({ database: { config: connection } }) } as unknown as ConfigRepository;
  return new DatabaseRepository(db, LoggingRepository.create(), configRepository);
};

afterAll(async () => {
  await Promise.all(databases.map((db) => db.destroy()));
});

describe(DatabaseRepository.name, () => {
  describe('runMigrations', () => {
    it('should apply every migration of both folders to an empty database without schema drift', async () => {
      const { db, url } = await newEmptyDatabase();
      const sut = newRepository(db, url);

      await sut.runMigrations();

      const expected = await expectedNames(migrationFolders);
      expect(expected.length).toBeGreaterThan(0);
      await expect(appliedNames(db)).resolves.toEqual(expected);
      await expect(sut.getMigrations()).resolves.toHaveLength(expected.length);

      const drift = await sut.getSchemaDrift();
      expect(drift.asHuman()).toEqual([]);
      expect(drift.items).toEqual([]);

      // a second run has nothing to do
      await sut.runMigrations();
      await expect(appliedNames(db)).resolves.toEqual(expected);
    });
  });

  describe(CompositeMigrationProvider.name, () => {
    it('should apply upstream and a fork migration together on a fresh database, in name order', async () => {
      const { db, url } = await newEmptyDatabase();
      const folders = [...migrationFolders, sampleFolder];

      const { error, results } = await newMigrator(db, folders).migrateToLatest();

      expect(error).toBeUndefined();
      const executed = (results ?? []).map(({ migrationName, status }) => ({ migrationName, status }));
      const expected = await expectedNames(folders);
      expect(executed).toEqual(expected.map((migrationName) => ({ migrationName, status: 'Success' })));
      expect(expected.indexOf(sampleMigration)).toBeGreaterThan(0);
      expect(expected.indexOf(sampleMigration)).toBeLessThan(expected.length - 1);

      await expect(appliedNames(db)).resolves.toEqual(expected);
      await expect(
        db
          .selectFrom('information_schema.tables' as any)
          .select('table_name' as any)
          .where('table_name' as any, '=', 'aero_sample')
          .execute(),
      ).resolves.toHaveLength(1);

      // the fork table is extra and ignored by the drift check
      const drift = await newRepository(db, url).getSchemaDrift();
      expect(drift.asHuman()).toEqual([]);
    });

    it('should apply a fork migration that sorts before already applied upstream migrations', async () => {
      const { db } = await newEmptyDatabase();
      const upstreamOnly = await expectedNames([upstreamMigrationFolder]);

      const first = await newMigrator(db, [upstreamMigrationFolder]).migrateToLatest();
      expect(first.error).toBeUndefined();
      await expect(appliedNames(db)).resolves.toEqual(upstreamOnly);

      // kysely's default (what upstream runs in production) refuses the out-of-order file
      const strict = await newMigrator(db, [upstreamMigrationFolder, sampleFolder], false).migrateToLatest();
      expect(String(strict.error)).toContain('corrupted migrations');
      await expect(appliedNames(db)).resolves.toEqual(upstreamOnly);

      const { error, results } = await newMigrator(db, [upstreamMigrationFolder, sampleFolder]).migrateToLatest();
      expect(error).toBeUndefined();
      expect(results).toEqual([{ migrationName: sampleMigration, direction: 'Up', status: 'Success' }]);
      await expect(appliedNames(db)).resolves.toEqual([...upstreamOnly, sampleMigration].toSorted());
    });

    it('should revert the fork migration with its down()', async () => {
      const { db } = await newEmptyDatabase();
      const folders = [upstreamMigrationFolder, sampleFolder];
      await newMigrator(db, [upstreamMigrationFolder]).migrateToLatest();
      await newMigrator(db, folders).migrateToLatest();

      // migrateDown reverts the most recently executed migration, not the one with the highest name
      const { error, results } = await newMigrator(db, folders).migrateDown();

      expect(error).toBeUndefined();
      expect(results).toEqual([{ migrationName: sampleMigration, direction: 'Down', status: 'Success' }]);
      await expect(appliedNames(db)).resolves.toEqual(await expectedNames([upstreamMigrationFolder]));
    });
  });
});
