import { join, sep } from 'node:path';
import {
  CompositeMigrationProvider,
  forkMigrationFolder,
  isMigrationFile,
  listMigrationFiles,
  migrationFolders,
  migrationName,
  upstreamMigrationFolder,
} from 'src/utils/migration';
import { describe, expect, it, vitest } from 'vitest';

const upstream = join(sep, 'app', 'schema', 'migrations');
const fork = join(sep, 'app', 'schema', 'migrations-aero');

const migration = (table: string) => ({ up: vitest.fn(), down: vitest.fn(), table });

const enoent = () => Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });

const newProvider = (
  folders: Record<string, string[] | Error>,
  modules: Record<string, unknown>,
  order: string[] = [upstream, fork],
) => {
  const readdir = vitest.fn((folder: string) => {
    const entries = folders[folder] ?? enoent();
    return entries instanceof Error ? Promise.reject(entries) : Promise.resolve(entries);
  });
  const importFile = vitest.fn((path: string) => {
    const module = modules[path];
    return module ? Promise.resolve(module) : Promise.reject(new Error(`Cannot find module ${path}`));
  });
  return { sut: new CompositeMigrationProvider(order, { readdir }, importFile), readdir, importFile };
};

describe('migrationFolders', () => {
  it('should list upstream first, then the fork folder next to it', () => {
    expect(migrationFolders).toEqual([upstreamMigrationFolder, forkMigrationFolder]);
    expect(upstreamMigrationFolder.endsWith(join('schema', 'migrations'))).toBe(true);
    expect(forkMigrationFolder.endsWith(join('schema', 'migrations-aero'))).toBe(true);
  });
});

describe('isMigrationFile', () => {
  it('should accept what kysely accepts', () => {
    expect(isMigrationFile('1744910873969-InitialMigration.ts')).toBe(true);
    expect(isMigrationFile('1744910873969-InitialMigration.js')).toBe(true);
    expect(isMigrationFile('1744910873969-InitialMigration.mjs')).toBe(true);
    expect(isMigrationFile('1744910873969-InitialMigration.mts')).toBe(true);
  });

  it('should skip declarations, source maps, ORDER and the README', () => {
    expect(isMigrationFile('1744910873969-InitialMigration.d.ts')).toBe(false);
    expect(isMigrationFile('1744910873969-InitialMigration.d.mts')).toBe(false);
    expect(isMigrationFile('1744910873969-InitialMigration.js.map')).toBe(false);
    expect(isMigrationFile('ORDER')).toBe(false);
    expect(isMigrationFile('README.md')).toBe(false);
  });
});

describe('migrationName', () => {
  it('should strip the extension only', () => {
    expect(migrationName('1744910873969-Initial.Migration.js')).toBe('1744910873969-Initial.Migration');
    expect(migrationName('1789200000000-PrivateMode.ts')).toBe('1789200000000-PrivateMode');
  });
});

describe('listMigrationFiles', () => {
  it('should filter and sort', async () => {
    const readdir = vitest.fn().mockResolvedValue(['ORDER', '2-B.js', '1-A.js', '1-A.js.map', '1-A.d.ts']);
    await expect(listMigrationFiles(upstream, { readdir })).resolves.toEqual(['1-A.js', '2-B.js']);
    expect(readdir).toHaveBeenCalledWith(upstream);
  });

  it('should treat a folder that does not exist as empty', async () => {
    const readdir = vitest.fn().mockRejectedValue(enoent());
    await expect(listMigrationFiles(fork, { readdir })).resolves.toEqual([]);
  });

  it('should rethrow any other error', async () => {
    const readdir = vitest.fn().mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(listMigrationFiles(fork, { readdir })).rejects.toThrow('denied');
  });
});

describe(CompositeMigrationProvider.name, () => {
  it('should merge both folders and sort by name', async () => {
    const { sut, importFile } = newProvider(
      {
        [upstream]: ['ORDER', '1790000000000-UpstreamLater.js', '1744910873969-InitialMigration.js'],
        [fork]: ['1789200000000-PrivateMode.js'],
      },
      {
        [join(upstream, '1744910873969-InitialMigration.js')]: migration('initial'),
        [join(upstream, '1790000000000-UpstreamLater.js')]: migration('later'),
        [join(fork, '1789200000000-PrivateMode.js')]: migration('private'),
      },
    );

    const migrations = await sut.getMigrations();

    expect(Object.keys(migrations)).toEqual([
      '1744910873969-InitialMigration',
      '1789200000000-PrivateMode',
      '1790000000000-UpstreamLater',
    ]);
    expect(migrations['1789200000000-PrivateMode']).toMatchObject({ table: 'private' });
    expect(importFile).toHaveBeenCalledTimes(3);
  });

  it('should unwrap a default export', async () => {
    const { sut } = newProvider(
      { [upstream]: ['1-A.js'], [fork]: [] },
      { [join(upstream, '1-A.js')]: { default: migration('a') } },
    );

    await expect(sut.getMigrations()).resolves.toMatchObject({ '1-A': { table: 'a' } });
  });

  it('should return only upstream migrations when the fork folder is missing or empty', async () => {
    const modules = { [join(upstream, '1-A.js')]: migration('a') };

    const missing = newProvider({ [upstream]: ['1-A.js'] }, modules);
    await expect(missing.sut.getMigrations()).resolves.toEqual({ '1-A': expect.objectContaining({ table: 'a' }) });

    const empty = newProvider({ [upstream]: ['1-A.js'], [fork]: ['README.md'] }, modules);
    await expect(empty.sut.getMigrations()).resolves.toEqual({ '1-A': expect.objectContaining({ table: 'a' }) });
  });

  it('should return an empty record when every folder is empty', async () => {
    const { sut } = newProvider({ [upstream]: [], [fork]: [] }, {});
    await expect(sut.getMigrations()).resolves.toEqual({});
  });

  it('should reject a name that exists in both folders', async () => {
    const { sut, importFile } = newProvider(
      { [upstream]: ['1-A.js'], [fork]: ['1-A.js'] },
      { [join(upstream, '1-A.js')]: migration('upstream'), [join(fork, '1-A.js')]: migration('fork') },
    );

    await expect(sut.getMigrations()).rejects.toThrow(
      `Migration "1-A" is defined twice: ${join(upstream, '1-A.js')} and ${join(fork, '1-A.js')}`,
    );
    expect(importFile).toHaveBeenCalledTimes(1);
  });

  it('should reject a file without an up() function', async () => {
    const { sut } = newProvider({ [upstream]: ['1-A.js'] }, { [join(upstream, '1-A.js')]: { down: vitest.fn() } });

    await expect(sut.getMigrations()).rejects.toThrow(
      `Migration file ${join(upstream, '1-A.js')} does not export an up() function`,
    );
  });

  it('should surface an import failure with the file path', async () => {
    const { sut } = newProvider({ [upstream]: ['1-A.js'] }, {});

    await expect(sut.getMigrations()).rejects.toThrow(`Cannot find module ${join(upstream, '1-A.js')}`);
  });

  it('should surface a readdir failure other than a missing folder', async () => {
    const { sut } = newProvider({ [upstream]: Object.assign(new Error('denied'), { code: 'EACCES' }) }, {});

    await expect(sut.getMigrations()).rejects.toThrow('denied');
  });
});
