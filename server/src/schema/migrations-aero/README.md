# Fork migrations

Every schema change of the Aero-immich fork lives in this folder. `src/schema/migrations/` and its `ORDER` file belong to upstream and are never touched by a fork branch.

## Why

Upstream's `migration-order` CI job requires `ORDER` to be append-only: a new migration must sort after every existing one. A fork migration carries the timestamp of the day it was written, and upstream keeps adding migrations after that date, so on the next rebase the fork file would sit in the middle of upstream's list. Kysely's migrator refuses that in production (`corrupted migrations: expected previously executed migration ... at index N`), and every rebase would mean renumbering the file and repairing the `kysely_migrations` rows of every installed instance.

Keeping the fork's files in their own folder solves both: a rebase replaces `migrations/` wholesale and never conflicts here, and the migrator merges the two folders (`CompositeMigrationProvider` in `src/utils/migration.ts`) with `allowUnorderedMigrations: true`, so pending migrations run in name order regardless of what upstream appended after them. Migration names are the file names, so an instance migrated before this folder existed sees the same names and nothing runs twice.

## Rules

- A fork migration goes here, named `<timestamp>-<Name>.ts` exactly like upstream's. Never add it to `migrations/` or to `ORDER`.
- A name must not exist in both folders: the migrator fails on boot when it does.
- `pnpm run migrations:generate` (sql-tools) writes the new file into `src/schema/migrations/` and appends it to `ORDER`. Move the file here and `git checkout -- src/schema/migrations/ORDER` before committing.
- `pnpm run migrations:run` and `migrations:revert` (sql-tools) only know one folder. Use the server itself (`immich-admin` commands, the medium test setup or a server boot) to apply fork migrations; the drift check and `immich-admin schema-check` see both folders.
- Keep `down()` complete: a fork release must remain revertible to upstream (`scripts/aero/revert-to-immich.sql` on `main` mirrors it).

Fork migrations sort after upstream's on a fresh install only while their timestamp is newer than upstream's last one; a fork migration must therefore never depend on an upstream migration that sorts after it.
