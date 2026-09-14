-- =============================================================================
-- revert-to-immich.sql (Aero-immich fork glue, lives only on `main`)
--
-- One-off cleanup that turns a database migrated by the Aero-immich server
-- image (ghcr.io/aeroverra/immich-server:<tag>-aero) back into a plain
-- upstream Immich database of the same version, so the container can be
-- switched back to ghcr.io/immich-app/immich-server:<tag> without hitting
--
--   Migration "1789200000000-PrivateMode" was already applied to this
--   database but is not in this version of Immich
--
-- (or the same for 1789339001650-AssetDeletedChecksum) on startup, and without schema-drift warnings afterwards.
--
-- The best answer is still "restore the pg_dump you took before the fork
-- image first started". This script is for when that dump is old or missing.
--
-- =============================================================================
-- WHAT IS LOST (irreversible)
-- =============================================================================
--
--   * The private flag of every asset (asset."isPrivate"). Every asset
--     becomes visible again to its owner and to anyone it is shared with.
--   * The private flag of every album (album."isPrivate"). Private albums
--     become ordinary albums.
--   * Private-mode session state (session."privateModeExpiresAt"): every
--     session is simply "not in private mode" afterwards. Sessions themselves
--     are kept; nobody is logged out.
--   * The `privateMode` block of each user's preferences (timeout, sidebar
--     toggle, include-in-memories). Every other preference is kept.
--   * The list of remembered checksums of permanently deleted assets
--     (table asset_deleted_checksum): a re-upload of a previously deleted file
--     is treated like any other upload afterwards. The "Previously deleted"
--     album, if one was created, stays as an ordinary album.
--   * The `deletedReimport` block of each user's preferences (mode, album id).
--   * The fork-only `privateMode.access` permission on API keys. Keys stay and
--     keep every other permission; upstream does not know this value.
--
-- Nothing else is touched. Photos, videos, albums, people, sharing, users,
-- API keys (apart from that one permission), jobs, the library on disk: all
-- untouched. The script only drops
-- the objects the three fork migrations created (listed below) and the rows
-- that record those migrations.
--
-- The fork migrations it reverses (server/src/schema/migrations-aero on `main`):
--
--   1789200000000-PrivateMode
--     columns   asset."isPrivate", album."isPrivate", session."privateModeExpiresAt"
--     index     asset_owner_private_idx
--     functions album_asset_private_after_insert, album_asset_private_after_delete,
--               asset_private_after_update
--     triggers  album_asset_private_after_insert  ON album_asset
--               album_asset_private_after_delete  ON album_asset
--               asset_private_after_update        ON asset
--     rows      7 migration_overrides rows (function_*, trigger_*, index_*)
--   1789250000000-PrivateModeSyncCompat
--     replaces the three function bodies and their migration_overrides rows;
--     creates nothing new
--   1789339001650-AssetDeletedChecksum
--     table     asset_deleted_checksum (primary key + foreign key to "user",
--               both dropped with the table; no migration_overrides rows)
--
-- The script is idempotent (IF EXISTS everywhere) and transactional: it
-- either finishes completely or leaves the database exactly as it was.
--
-- =============================================================================
-- HOW TO RUN
-- =============================================================================
--
-- 1. Stop the server container. The script takes ACCESS EXCLUSIVE locks on
--    asset, album and session; a running server would block or race it.
--
--        docker compose stop immich-server
--
-- 2. Take a pg_dump NOW. If anything goes wrong this is the way back.
--
--        docker compose exec database pg_dump -U postgres -d immich \
--          > aero-pre-revert-$(date +%F).sql
--
--    (adjust -U / -d to DB_USERNAME / DB_DATABASE_NAME from your .env)
--
-- 3. Copy the script into the postgres container and run it. The extra -c
--    flag sets the data-loss acknowledgement; the safety check at the top of
--    the script refuses to run without it. Both statements share one psql
--    session, so the session setting made by -c is visible to the -f script.
--
--        docker compose cp scripts/aero/revert-to-immich.sql database:/tmp/
--        docker compose exec database psql -U postgres -d immich \
--          -v ON_ERROR_STOP=1 \
--          -c "SET aero.revert_token = 'i_accept_data_loss';" \
--          -f /tmp/revert-to-immich.sql
--
--    ON_ERROR_STOP=1 matters: without it psql keeps going past the first
--    error. The whole script is wrapped in BEGIN/COMMIT, so a mid-script
--    failure rolls everything back either way.
--
-- 4. In docker-compose.yml point the server image back at upstream, at the
--    SAME upstream version the fork image was built from (the fork tag
--    v3.2.0-aero was built from upstream v3.2.0):
--
--        image: ghcr.io/immich-app/immich-server:v3.2.0
--
--    then `docker compose up -d immich-server`. The log should show
--    "Finished running migrations" with no migration names and
--    "No schema drift detected". A newer upstream version also works (it
--    just runs its own newer migrations); an OLDER one does not, since
--    Immich never supports downgrading.
--
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- -----------------------------------------------------------------------------
-- Safety check. Refuses to run unless the session has
--   SET aero.revert_token = 'i_accept_data_loss';
-- (see HOW TO RUN, step 3).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF current_setting('aero.revert_token', true) IS DISTINCT FROM 'i_accept_data_loss' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'revert-to-immich.sql refused: read the header, then run psql with -c "SET aero.revert_token = ''i_accept_data_loss'';" before -f.',
      HINT = 'Stop the server container and take a pg_dump first.';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. Triggers (they reference the functions dropped in step 2).
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "asset_private_after_update" ON "asset";
DROP TRIGGER IF EXISTS "album_asset_private_after_delete" ON "album_asset";
DROP TRIGGER IF EXISTS "album_asset_private_after_insert" ON "album_asset";

-- -----------------------------------------------------------------------------
-- 2. Trigger functions. Upstream's schema-drift check does not ignore extra
--    functions, so leaving these would produce a drift warning on every boot.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS asset_private_after_update();
DROP FUNCTION IF EXISTS album_asset_private_after_delete();
DROP FUNCTION IF EXISTS album_asset_private_after_insert();

-- -----------------------------------------------------------------------------
-- 3. Index (partial index on asset."isPrivate"; dropping the column would
--    remove it too, but being explicit keeps the audit trail obvious).
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS "asset_owner_private_idx";

-- -----------------------------------------------------------------------------
-- 4. Columns. This is the data loss: the private flags and the per-session
--    private-mode expiry.
-- -----------------------------------------------------------------------------
ALTER TABLE "session" DROP COLUMN IF EXISTS "privateModeExpiresAt";
ALTER TABLE "album" DROP COLUMN IF EXISTS "isPrivate";
ALTER TABLE "asset" DROP COLUMN IF EXISTS "isPrivate";

-- -----------------------------------------------------------------------------
-- 5. User preferences. The fork stores its settings under the `privateMode`
--    key of the preferences JSON in user_metadata. Upstream would ignore the
--    key and drop it on the next save; removing it here leaves the row
--    exactly as upstream would have written it.
-- -----------------------------------------------------------------------------
UPDATE "user_metadata"
   SET "value" = "value" - 'privateMode'
 WHERE "key" = 'preferences'
   AND "value" ? 'privateMode';

-- -----------------------------------------------------------------------------
-- 5b. Previously deleted files (1789339001650-AssetDeletedChecksum): the
--     remembered checksums and the `deletedReimport` preference block. The
--     table has no dependents; its constraints go with it.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS "asset_deleted_checksum";

UPDATE "user_metadata"
   SET "value" = "value" - 'deletedReimport'
 WHERE "key" = 'preferences'
   AND "value" ? 'deletedReimport';

-- -----------------------------------------------------------------------------
-- 5c. API key permission `privateMode.access` (no migration: permissions are a
--     varchar array). Upstream validates permissions against its own enum, so
--     an unknown value would break listing and editing the key.
-- -----------------------------------------------------------------------------
UPDATE "api_key"
   SET "permissions" = array_remove("permissions", 'privateMode.access')
 WHERE 'privateMode.access' = ANY("permissions");

-- -----------------------------------------------------------------------------
-- 5d. Automatic stacks (1789424597544-AutoStacks): the exclusion list of photos
--     the user took out of automatic stacks, the per-asset "evaluated" marker,
--     the capture time index, the per-user opt-in and the job settings. The
--     automatic stacks themselves stay as ordinary stacks upstream shows as is.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS "stack_auto_exclusion";
ALTER TABLE "asset_job_status" DROP COLUMN IF EXISTS "autoStackedAt";
DROP INDEX IF EXISTS "asset_ownerId_fileCreatedAt_idx";

UPDATE "user_metadata"
   SET "value" = "value" - 'autoStack'
 WHERE "key" = 'preferences'
   AND "value" ? 'autoStack';

-- the "include stacked items" choice for bulk actions (no migration)
UPDATE "user_metadata"
   SET "value" = "value" - 'stackActions'
 WHERE "key" = 'preferences'
   AND "value" ? 'stackActions';

-- -----------------------------------------------------------------------------
-- 5e. Face attributes and image quality (1789423484887-FaceAttributes): scores
--     computed by the fork machine-learning image; faces and people are not
--     touched.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS "asset_face_attribute";
DROP TABLE IF EXISTS "asset_quality";

-- -----------------------------------------------------------------------------
-- 5f. Stack source (1789422771385-StackSource): manual or automatic, the
--     grouping preference and the sync checkpoints of the fork-only StacksV2
--     entities (the type column is a varchar, upstream ignores nothing it does
--     not know, so the rows go).
-- -----------------------------------------------------------------------------
ALTER TABLE "stack" DROP COLUMN IF EXISTS "source";
DROP TYPE IF EXISTS "stack_source_enum";

UPDATE "user_metadata"
   SET "value" = "value" - 'stacks'
 WHERE "key" = 'preferences'
   AND "value" ? 'stacks';

DELETE FROM "session_sync_checkpoint"
 WHERE "type" IN ('StackV2', 'PartnerStackV2', 'PartnerStackBackfillV2');

-- -----------------------------------------------------------------------------
-- 5g. System config keys of the features above. Upstream validates the stored
--     config against its own schema.
-- -----------------------------------------------------------------------------
UPDATE "system_metadata"
   SET "value" = "value" #- '{machineLearning,autoStack}'
                         #- '{machineLearning,faceAttributes}'
                         #- '{job,faceAttributes}'
                         #- '{nightlyTasks,autoStack}'
 WHERE "key" = 'system-config';

-- -----------------------------------------------------------------------------
-- 6. migration_overrides rows. Immich's sql-tools compares these against the
--    code's overrides during the drift check; rows for objects the code no
--    longer declares must go.
-- -----------------------------------------------------------------------------
DELETE FROM "migration_overrides"
 WHERE "name" IN (
   'function_album_asset_private_after_insert',
   'function_album_asset_private_after_delete',
   'function_asset_private_after_update',
   'trigger_album_asset_private_after_insert',
   'trigger_album_asset_private_after_delete',
   'trigger_asset_private_after_update',
   'index_asset_owner_private_idx'
 );

-- -----------------------------------------------------------------------------
-- 7. kysely_migrations rows. With these present, upstream's migrator aborts on
--    boot with "previously executed migration ... is missing". Only fork
--    migrations are listed; every upstream migration row stays.
--    (scripts/aero/revert-coverage-check.sh asserts this list matches the
--    files in server/src/schema/migrations-aero.)
-- -----------------------------------------------------------------------------
DELETE FROM "kysely_migrations"
 WHERE "name" IN (
   '1789200000000-PrivateMode',
   '1789250000000-PrivateModeSyncCompat',
   '1789339001650-AssetDeletedChecksum',
   '1789422771385-StackSource',
   '1789423484887-FaceAttributes',
   '1789424597544-AutoStacks'
 );

-- -----------------------------------------------------------------------------
-- 8. Verify and commit. Any leftover aborts the transaction.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  leftover text;
BEGIN
  SELECT string_agg(item, ', ') INTO leftover
  FROM (
    SELECT 'column ' || table_name || '.' || column_name AS item
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND (table_name, column_name) IN (('asset', 'isPrivate'), ('album', 'isPrivate'), ('session', 'privateModeExpiresAt'))
    UNION ALL
    SELECT 'function ' || proname
      FROM pg_proc
     WHERE pronamespace = current_schema()::regnamespace
       AND proname IN ('asset_private_after_update', 'album_asset_private_after_delete', 'album_asset_private_after_insert')
    UNION ALL
    SELECT 'trigger ' || tgname
      FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgname IN ('asset_private_after_update', 'album_asset_private_after_delete', 'album_asset_private_after_insert')
    UNION ALL
    SELECT 'index ' || indexname
      FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname = 'asset_owner_private_idx'
    UNION ALL
    SELECT 'migration_overrides ' || name
      FROM migration_overrides
     WHERE name LIKE '%\_private\_%' ESCAPE '\'
    UNION ALL
    SELECT 'kysely_migrations ' || name
      FROM kysely_migrations
     WHERE name LIKE '%PrivateMode%'
        OR name LIKE '%AssetDeletedChecksum%'
        OR name LIKE '%-StackSource'
        OR name LIKE '%-FaceAttributes'
        OR name LIKE '%-AutoStacks'
    UNION ALL
    SELECT 'user_metadata preferences.privateMode for user ' || "userId"
      FROM user_metadata
     WHERE key = 'preferences'
       AND value ? 'privateMode'
    UNION ALL
    SELECT 'table ' || table_name
      FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = 'asset_deleted_checksum'
    UNION ALL
    SELECT 'user_metadata preferences.deletedReimport for user ' || "userId"
      FROM user_metadata
     WHERE key = 'preferences'
       AND value ? 'deletedReimport'
    UNION ALL
    SELECT 'api_key privateMode.access permission on key ' || "id"
      FROM api_key
     WHERE 'privateMode.access' = ANY("permissions")
    UNION ALL
    SELECT 'table ' || table_name
      FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name IN ('stack_auto_exclusion', 'asset_face_attribute', 'asset_quality')
    UNION ALL
    SELECT 'column ' || table_name || '.' || column_name
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND (table_name, column_name) IN (('stack', 'source'), ('asset_job_status', 'autoStackedAt'))
    UNION ALL
    SELECT 'type ' || typname
      FROM pg_type
     WHERE typnamespace = current_schema()::regnamespace
       AND typname = 'stack_source_enum'
    UNION ALL
    SELECT 'index ' || indexname
      FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname = 'asset_ownerId_fileCreatedAt_idx'
    UNION ALL
    SELECT 'user_metadata preferences.' || k || ' for user ' || "userId"
      FROM user_metadata, unnest(ARRAY['stacks', 'autoStack', 'stackActions']) AS k
     WHERE key = 'preferences'
       AND value ? k
    UNION ALL
    SELECT 'session_sync_checkpoint ' || "type"
      FROM session_sync_checkpoint
     WHERE "type" IN ('StackV2', 'PartnerStackV2', 'PartnerStackBackfillV2')
  ) AS leftovers;

  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'revert-to-immich: fork objects still present after cleanup, rolling back: %', leftover;
  END IF;

  RAISE NOTICE 'revert-to-immich: done. Point the server image at ghcr.io/immich-app/immich-server:<same upstream version> and start it.';
END $$;

COMMIT;
