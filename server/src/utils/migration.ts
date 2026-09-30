import { Migration, MigrationProvider } from 'kysely';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/* eslint-disable unicorn/prefer-module */
/** Upstream's migrations. Never add a file here, see src/schema/migrations-aero/README.md */
export const upstreamMigrationFolder = join(__dirname, '..', 'schema/migrations');
/** The fork's migrations, kept apart from upstream's so a rebase never touches them */
export const forkMigrationFolder = join(__dirname, '..', 'schema/migrations-aero');
/* eslint-enable unicorn/prefer-module */
export const migrationFolders = [upstreamMigrationFolder, forkMigrationFolder];

type MigrationFs = { readdir: (folder: string) => Promise<string[]> };
const nodeFs: MigrationFs = { readdir };

/** The file filter of kysely's FileMigrationProvider */
export const isMigrationFile = (fileName: string) =>
  fileName.endsWith('.js') ||
  (fileName.endsWith('.ts') && !fileName.endsWith('.d.ts')) ||
  fileName.endsWith('.mjs') ||
  (fileName.endsWith('.mts') && !fileName.endsWith('.d.mts'));

export const migrationName = (fileName: string) => fileName.slice(0, fileName.lastIndexOf('.'));

/**
 * Migration files of a folder, sorted by name. A folder that does not exist counts as empty:
 * `nest build` only emits .ts files, so a migration folder that holds nothing but its README has
 * no counterpart in dist/.
 */
export const listMigrationFiles = async (folder: string, fs: MigrationFs = nodeFs) => {
  try {
    const fileNames = await fs.readdir(folder);
    return fileNames.filter((fileName) => isMigrationFile(fileName)).toSorted();
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
};

/**
 * Migrations of several folders merged into the single record kysely's Migrator expects, sorted by
 * name (the timestamp prefix). A name may only exist in one folder: the name is the key of the
 * kysely_migrations row, so two files claiming it would silently shadow each other.
 *
 * Files are loaded through a file:// URL so the same code works from the compiled CommonJS output,
 * from vitest and on Windows (a bare absolute path is not a valid ESM specifier there).
 */
export class CompositeMigrationProvider implements MigrationProvider {
  constructor(
    private folders: string[],
    private fs: MigrationFs = nodeFs,
    private importFile: (path: string) => Promise<unknown> = (path) => import(pathToFileURL(path).href),
  ) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {};
    const sources: Record<string, string> = {};

    for (const folder of this.folders) {
      for (const fileName of await listMigrationFiles(folder, this.fs)) {
        const name = migrationName(fileName);
        const path = join(folder, fileName);
        if (sources[name]) {
          throw new Error(`Migration "${name}" is defined twice: ${sources[name]} and ${path}`);
        }

        const module = (await this.importFile(path)) as { default?: unknown };
        const migration = isMigration(module?.default) ? module.default : module;
        if (!isMigration(migration)) {
          throw new Error(`Migration file ${path} does not export an up() function`);
        }

        sources[name] = path;
        migrations[name] = migration;
      }
    }

    return Object.fromEntries(
      Object.keys(migrations)
        .toSorted()
        .map((name) => [name, migrations[name]]),
    );
  }
}

const isMigration = (value: unknown): value is Migration =>
  typeof value === 'object' && value !== null && typeof (value as Migration).up === 'function';
