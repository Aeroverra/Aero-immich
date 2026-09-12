import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset" ADD "isPrivate" boolean NOT NULL DEFAULT false;`.execute(db);
  await sql`ALTER TABLE "album" ADD "isPrivate" boolean NOT NULL DEFAULT false;`.execute(db);
  await sql`ALTER TABLE "session" ADD "privateModeExpiresAt" timestamp with time zone;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION album_asset_private_after_insert()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      -- adding an asset to a private album makes the asset private
      UPDATE asset SET "isPrivate" = true
      WHERE "id" IN (
        SELECT n."assetId" FROM new n
        INNER JOIN album a ON a."id" = n."albumId"
        WHERE a."isPrivate" = true
      ) AND "isPrivate" = false;

      -- adding a private asset makes the album private
      UPDATE album SET "isPrivate" = true, "updatedAt" = clock_timestamp(), "updateId" = immich_uuid_v7(clock_timestamp())
      WHERE "id" IN (
        SELECT n."albumId" FROM new n
        INNER JOIN asset s ON s."id" = n."assetId"
        WHERE s."isPrivate" = true AND s."deletedAt" IS NULL
      ) AND "isPrivate" = false;
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION album_asset_private_after_delete()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      UPDATE album SET "isPrivate" = false, "updatedAt" = clock_timestamp(), "updateId" = immich_uuid_v7(clock_timestamp())
      WHERE "id" IN (SELECT DISTINCT "albumId" FROM old)
        AND "isPrivate" = true
        AND NOT EXISTS (
          SELECT FROM album_asset aa
          INNER JOIN asset s ON s."id" = aa."assetId"
          WHERE aa."albumId" = album."id" AND s."isPrivate" = true AND s."deletedAt" IS NULL
        );
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION asset_private_after_update()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      UPDATE album SET "isPrivate" = true, "updatedAt" = clock_timestamp(), "updateId" = immich_uuid_v7(clock_timestamp())
      WHERE "isPrivate" = false
        AND "id" IN (
          SELECT aa."albumId" FROM new n
          INNER JOIN album_asset aa ON aa."assetId" = n."id"
          WHERE n."isPrivate" = true AND n."deletedAt" IS NULL
        );

      UPDATE album SET "isPrivate" = false, "updatedAt" = clock_timestamp(), "updateId" = immich_uuid_v7(clock_timestamp())
      WHERE "isPrivate" = true
        AND "id" IN (SELECT aa."albumId" FROM new n INNER JOIN album_asset aa ON aa."assetId" = n."id")
        AND NOT EXISTS (
          SELECT FROM album_asset aa
          INNER JOIN asset s ON s."id" = aa."assetId"
          WHERE aa."albumId" = album."id" AND s."isPrivate" = true AND s."deletedAt" IS NULL
        );
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "album_asset_private_after_insert"
  AFTER INSERT ON "album_asset"
  REFERENCING NEW TABLE AS "new"
  FOR EACH STATEMENT
  WHEN (pg_trigger_depth() <= 1)
  EXECUTE FUNCTION album_asset_private_after_insert();`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "album_asset_private_after_delete"
  AFTER DELETE ON "album_asset"
  REFERENCING OLD TABLE AS "old"
  FOR EACH STATEMENT
  WHEN (pg_trigger_depth() <= 1)
  EXECUTE FUNCTION album_asset_private_after_delete();`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "asset_private_after_update"
  AFTER UPDATE ON "asset"
  REFERENCING NEW TABLE AS "new"
  FOR EACH STATEMENT
  WHEN (pg_trigger_depth() <= 1)
  EXECUTE FUNCTION asset_private_after_update();`.execute(db);
  await sql`CREATE INDEX "asset_owner_private_idx" ON "asset" ("ownerId") WHERE "isPrivate" = true;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "asset_owner_private_idx";`.execute(db);
  await sql`DROP TRIGGER IF EXISTS "asset_private_after_update" ON "asset";`.execute(db);
  await sql`DROP TRIGGER IF EXISTS "album_asset_private_after_delete" ON "album_asset";`.execute(db);
  await sql`DROP TRIGGER IF EXISTS "album_asset_private_after_insert" ON "album_asset";`.execute(db);
  await sql`DROP FUNCTION IF EXISTS asset_private_after_update;`.execute(db);
  await sql`DROP FUNCTION IF EXISTS album_asset_private_after_delete;`.execute(db);
  await sql`DROP FUNCTION IF EXISTS album_asset_private_after_insert;`.execute(db);
  await sql`ALTER TABLE "session" DROP COLUMN "privateModeExpiresAt";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "isPrivate";`.execute(db);
  await sql`ALTER TABLE "asset" DROP COLUMN "isPrivate";`.execute(db);
}
