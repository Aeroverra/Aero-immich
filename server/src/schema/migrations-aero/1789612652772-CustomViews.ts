import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION tag_delete_audit()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      INSERT INTO tag_audit ("tagId", "userId")
      SELECT "id", "userId"
      FROM OLD;
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION tag_asset_delete_audit()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      INSERT INTO tag_asset_audit ("tagId", "assetId", "userId")
      SELECT o."tagId", o."assetId", t."userId" FROM OLD o
      INNER JOIN tag t ON t."id" = o."tagId"
      WHERE o."assetId" IN (SELECT "id" FROM asset WHERE "id" IN (SELECT "assetId" FROM OLD));
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION tag_asset_after_insert()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      -- a tag change can move an asset in or out of a view; touching the asset and the rows sync sends with it
      -- hands out fresh updateIds, so clients that only receive the default view re-evaluate them
      UPDATE asset SET "updatedAt" = clock_timestamp() WHERE "id" IN (SELECT DISTINCT "assetId" FROM new);
      UPDATE asset_exif SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM new);
      UPDATE album_asset SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM new);
      UPDATE stack SET "updatedAt" = clock_timestamp() WHERE "primaryAssetId" IN (SELECT DISTINCT "assetId" FROM new);
      UPDATE asset_face SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM new);
      UPDATE memory_asset SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM new);
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION tag_asset_after_delete()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      -- a tag change can move an asset in or out of a view; touching the asset and the rows sync sends with it
      -- hands out fresh updateIds, so clients that only receive the default view re-evaluate them
      UPDATE asset SET "updatedAt" = clock_timestamp() WHERE "id" IN (SELECT DISTINCT "assetId" FROM old);
      UPDATE asset_exif SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM old);
      UPDATE album_asset SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM old);
      UPDATE stack SET "updatedAt" = clock_timestamp() WHERE "primaryAssetId" IN (SELECT DISTINCT "assetId" FROM old);
      UPDATE asset_face SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM old);
      UPDATE memory_asset SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM old);
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION view_delete_audit()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      INSERT INTO view_audit ("viewId", "userId")
      SELECT "id", "ownerId"
      FROM OLD;
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION view_tag_delete_audit()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      INSERT INTO view_tag_audit ("viewId", "tagId", "userId")
      SELECT o."viewId", o."tagId", v."ownerId" FROM OLD o
      INNER JOIN view v ON v."id" = o."viewId"
      WHERE o."tagId" IN (SELECT "id" FROM tag WHERE "id" IN (SELECT "tagId" FROM OLD));
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE TYPE "view_access_enum" AS ENUM ('open','locked','private');`.execute(db);
  await sql`CREATE TYPE "view_private_assets_enum" AS ENUM ('hide','unlocked','only');`.execute(db);
  await sql`CREATE TYPE "view_tag_mode_enum" AS ENUM ('include','exclude');`.execute(db);
  await sql`ALTER TABLE "session" ADD "viewId" uuid;`.execute(db);
  await sql`ALTER TABLE "session" ADD "viewExpiresAt" timestamp with time zone;`.execute(db);
  await sql`CREATE INDEX "session_viewId_idx" ON "session" ("viewId");`.execute(db);
  await sql`CREATE TABLE "view" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "ownerId" uuid NOT NULL,
  "name" character varying NOT NULL,
  "order" integer NOT NULL DEFAULT 0,
  "isDefault" boolean NOT NULL DEFAULT false,
  "access" view_access_enum NOT NULL DEFAULT 'open',
  "includeAll" boolean NOT NULL DEFAULT false,
  "includeUntagged" boolean NOT NULL DEFAULT false,
  "privateAssets" view_private_assets_enum NOT NULL DEFAULT 'unlocked',
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "view_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "view_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`ALTER TABLE "session" ADD CONSTRAINT "session_viewId_fkey" FOREIGN KEY ("viewId") REFERENCES "view" ("id") ON UPDATE CASCADE ON DELETE SET NULL;`.execute(
    db,
  );
  await sql`ALTER TABLE "tag" ADD "isHidden" boolean NOT NULL DEFAULT false;`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "tag_delete_audit"
  AFTER DELETE ON "tag"
  REFERENCING OLD TABLE AS "old"
  FOR EACH STATEMENT
  EXECUTE FUNCTION tag_delete_audit();`.execute(db);
  await sql`ALTER TABLE "tag_asset" ADD "updateId" uuid NOT NULL DEFAULT immich_uuid_v7();`.execute(db);
  await sql`CREATE INDEX "tag_asset_updateId_idx" ON "tag_asset" ("updateId");`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "tag_asset_after_delete"
  AFTER DELETE ON "tag_asset"
  REFERENCING OLD TABLE AS "old"
  FOR EACH STATEMENT
  EXECUTE FUNCTION tag_asset_after_delete();`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "tag_asset_after_insert"
  AFTER INSERT ON "tag_asset"
  REFERENCING NEW TABLE AS "new"
  FOR EACH STATEMENT
  EXECUTE FUNCTION tag_asset_after_insert();`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "tag_asset_delete_audit"
  AFTER DELETE ON "tag_asset"
  REFERENCING OLD TABLE AS "old"
  FOR EACH STATEMENT
  EXECUTE FUNCTION tag_asset_delete_audit();`.execute(db);
  await sql`CREATE UNIQUE INDEX "view_ownerId_isDefault_uidx" ON "view" ("ownerId") WHERE ("isDefault" = true);`.execute(
    db,
  );
  await sql`CREATE INDEX "view_ownerId_idx" ON "view" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "view_updateId_idx" ON "view" ("updateId");`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "view_delete_audit"
  AFTER DELETE ON "view"
  REFERENCING OLD TABLE AS "old"
  FOR EACH STATEMENT
  WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION view_delete_audit();`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "view_updatedAt"
  BEFORE UPDATE ON "view"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
  await sql`CREATE TABLE "tag_asset_audit" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "tagId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "deletedAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "tag_asset_audit_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "tag_asset_audit_userId_idx" ON "tag_asset_audit" ("userId");`.execute(db);
  await sql`CREATE INDEX "tag_asset_audit_deletedAt_idx" ON "tag_asset_audit" ("deletedAt");`.execute(db);
  await sql`CREATE TABLE "tag_audit" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "tagId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "deletedAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "tag_audit_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "tag_audit_userId_idx" ON "tag_audit" ("userId");`.execute(db);
  await sql`CREATE INDEX "tag_audit_deletedAt_idx" ON "tag_audit" ("deletedAt");`.execute(db);
  await sql`CREATE TABLE "view_audit" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "viewId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "deletedAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "view_audit_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "view_audit_userId_idx" ON "view_audit" ("userId");`.execute(db);
  await sql`CREATE INDEX "view_audit_deletedAt_idx" ON "view_audit" ("deletedAt");`.execute(db);
  await sql`CREATE TABLE "view_tag_audit" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "viewId" uuid NOT NULL,
  "tagId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "deletedAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "view_tag_audit_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "view_tag_audit_userId_idx" ON "view_tag_audit" ("userId");`.execute(db);
  await sql`CREATE INDEX "view_tag_audit_deletedAt_idx" ON "view_tag_audit" ("deletedAt");`.execute(db);
  await sql`CREATE TABLE "view_tag" (
  "viewId" uuid NOT NULL,
  "tagId" uuid NOT NULL,
  "mode" view_tag_mode_enum NOT NULL,
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "view_tag_viewId_fkey" FOREIGN KEY ("viewId") REFERENCES "view" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "view_tag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tag" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "view_tag_pkey" PRIMARY KEY ("viewId", "tagId")
);`.execute(db);
  await sql`CREATE INDEX "view_tag_viewId_idx" ON "view_tag" ("viewId");`.execute(db);
  await sql`CREATE INDEX "view_tag_tagId_idx" ON "view_tag" ("tagId");`.execute(db);
  await sql`CREATE INDEX "view_tag_updateId_idx" ON "view_tag" ("updateId");`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "view_tag_delete_audit"
  AFTER DELETE ON "view_tag"
  REFERENCING OLD TABLE AS "old"
  FOR EACH STATEMENT
  WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION view_tag_delete_audit();`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('function_tag_delete_audit', '{"type":"function","name":"tag_delete_audit","sql":"CREATE OR REPLACE FUNCTION tag_delete_audit()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      INSERT INTO tag_audit (\\"tagId\\", \\"userId\\")\\n      SELECT \\"id\\", \\"userId\\"\\n      FROM OLD;\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('function_tag_asset_delete_audit', '{"type":"function","name":"tag_asset_delete_audit","sql":"CREATE OR REPLACE FUNCTION tag_asset_delete_audit()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      INSERT INTO tag_asset_audit (\\"tagId\\", \\"assetId\\", \\"userId\\")\\n      SELECT o.\\"tagId\\", o.\\"assetId\\", t.\\"userId\\" FROM OLD o\\n      INNER JOIN tag t ON t.\\"id\\" = o.\\"tagId\\"\\n      WHERE o.\\"assetId\\" IN (SELECT \\"id\\" FROM asset WHERE \\"id\\" IN (SELECT \\"assetId\\" FROM OLD));\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('function_tag_asset_after_insert', '{"type":"function","name":"tag_asset_after_insert","sql":"CREATE OR REPLACE FUNCTION tag_asset_after_insert()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      -- a tag change can move an asset in or out of a view; touching the asset and the rows sync sends with it\\n      -- hands out fresh updateIds, so clients that only receive the default view re-evaluate them\\n      UPDATE asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"id\\" IN (SELECT DISTINCT \\"assetId\\" FROM new);\\n      UPDATE asset_exif SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM new);\\n      UPDATE album_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM new);\\n      UPDATE stack SET \\"updatedAt\\" = clock_timestamp() WHERE \\"primaryAssetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM new);\\n      UPDATE asset_face SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM new);\\n      UPDATE memory_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM new);\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('function_tag_asset_after_delete', '{"type":"function","name":"tag_asset_after_delete","sql":"CREATE OR REPLACE FUNCTION tag_asset_after_delete()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      -- a tag change can move an asset in or out of a view; touching the asset and the rows sync sends with it\\n      -- hands out fresh updateIds, so clients that only receive the default view re-evaluate them\\n      UPDATE asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"id\\" IN (SELECT DISTINCT \\"assetId\\" FROM old);\\n      UPDATE asset_exif SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM old);\\n      UPDATE album_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM old);\\n      UPDATE stack SET \\"updatedAt\\" = clock_timestamp() WHERE \\"primaryAssetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM old);\\n      UPDATE asset_face SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM old);\\n      UPDATE memory_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM old);\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('function_view_delete_audit', '{"type":"function","name":"view_delete_audit","sql":"CREATE OR REPLACE FUNCTION view_delete_audit()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      INSERT INTO view_audit (\\"viewId\\", \\"userId\\")\\n      SELECT \\"id\\", \\"ownerId\\"\\n      FROM OLD;\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('function_view_tag_delete_audit', '{"type":"function","name":"view_tag_delete_audit","sql":"CREATE OR REPLACE FUNCTION view_tag_delete_audit()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      INSERT INTO view_tag_audit (\\"viewId\\", \\"tagId\\", \\"userId\\")\\n      SELECT o.\\"viewId\\", o.\\"tagId\\", v.\\"ownerId\\" FROM OLD o\\n      INNER JOIN view v ON v.\\"id\\" = o.\\"viewId\\"\\n      WHERE o.\\"tagId\\" IN (SELECT \\"id\\" FROM tag WHERE \\"id\\" IN (SELECT \\"tagId\\" FROM OLD));\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_view_delete_audit', '{"type":"trigger","name":"view_delete_audit","sql":"CREATE OR REPLACE TRIGGER \\"view_delete_audit\\"\\n  AFTER DELETE ON \\"view\\"\\n  REFERENCING OLD TABLE AS \\"old\\"\\n  FOR EACH STATEMENT\\n  WHEN (pg_trigger_depth() = 0)\\n  EXECUTE FUNCTION view_delete_audit();"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_view_updatedAt', '{"type":"trigger","name":"view_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"view_updatedAt\\"\\n  BEFORE UPDATE ON \\"view\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_view_ownerId_isDefault_uidx', '{"type":"index","name":"view_ownerId_isDefault_uidx","sql":"CREATE UNIQUE INDEX \\"view_ownerId_isDefault_uidx\\" ON \\"view\\" (\\"ownerId\\") WHERE (\\"isDefault\\" = true);"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_tag_delete_audit', '{"type":"trigger","name":"tag_delete_audit","sql":"CREATE OR REPLACE TRIGGER \\"tag_delete_audit\\"\\n  AFTER DELETE ON \\"tag\\"\\n  REFERENCING OLD TABLE AS \\"old\\"\\n  FOR EACH STATEMENT\\n  EXECUTE FUNCTION tag_delete_audit();"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_tag_asset_after_delete', '{"type":"trigger","name":"tag_asset_after_delete","sql":"CREATE OR REPLACE TRIGGER \\"tag_asset_after_delete\\"\\n  AFTER DELETE ON \\"tag_asset\\"\\n  REFERENCING OLD TABLE AS \\"old\\"\\n  FOR EACH STATEMENT\\n  EXECUTE FUNCTION tag_asset_after_delete();"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_tag_asset_after_insert', '{"type":"trigger","name":"tag_asset_after_insert","sql":"CREATE OR REPLACE TRIGGER \\"tag_asset_after_insert\\"\\n  AFTER INSERT ON \\"tag_asset\\"\\n  REFERENCING NEW TABLE AS \\"new\\"\\n  FOR EACH STATEMENT\\n  EXECUTE FUNCTION tag_asset_after_insert();"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_tag_asset_delete_audit', '{"type":"trigger","name":"tag_asset_delete_audit","sql":"CREATE OR REPLACE TRIGGER \\"tag_asset_delete_audit\\"\\n  AFTER DELETE ON \\"tag_asset\\"\\n  REFERENCING OLD TABLE AS \\"old\\"\\n  FOR EACH STATEMENT\\n  EXECUTE FUNCTION tag_asset_delete_audit();"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_view_tag_delete_audit', '{"type":"trigger","name":"view_tag_delete_audit","sql":"CREATE OR REPLACE TRIGGER \\"view_tag_delete_audit\\"\\n  AFTER DELETE ON \\"view_tag\\"\\n  REFERENCING OLD TABLE AS \\"old\\"\\n  FOR EACH STATEMENT\\n  WHEN (pg_trigger_depth() = 0)\\n  EXECUTE FUNCTION view_tag_delete_audit();"}'::jsonb);`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER "tag_delete_audit" ON "tag";`.execute(db);
  await sql`DROP FUNCTION tag_delete_audit;`.execute(db);
  await sql`DROP TRIGGER "tag_asset_delete_audit" ON "tag_asset";`.execute(db);
  await sql`DROP FUNCTION tag_asset_delete_audit;`.execute(db);
  await sql`DROP TRIGGER "tag_asset_after_insert" ON "tag_asset";`.execute(db);
  await sql`DROP FUNCTION tag_asset_after_insert;`.execute(db);
  await sql`DROP TRIGGER "tag_asset_after_delete" ON "tag_asset";`.execute(db);
  await sql`DROP FUNCTION tag_asset_after_delete;`.execute(db);
  await sql`DROP TRIGGER "view_delete_audit" ON "view";`.execute(db);
  await sql`DROP FUNCTION view_delete_audit;`.execute(db);
  await sql`DROP TRIGGER "view_tag_delete_audit" ON "view_tag";`.execute(db);
  await sql`DROP FUNCTION view_tag_delete_audit;`.execute(db);
  await sql`ALTER TABLE "session" DROP CONSTRAINT "session_viewId_fkey";`.execute(db);
  await sql`DROP TABLE "view_tag";`.execute(db);
  await sql`DROP TABLE "view";`.execute(db);
  await sql`DROP TYPE "view_access_enum";`.execute(db);
  await sql`DROP TYPE "view_private_assets_enum";`.execute(db);
  await sql`DROP TYPE "view_tag_mode_enum";`.execute(db);
  await sql`DROP INDEX "tag_asset_updateId_idx";`.execute(db);
  await sql`ALTER TABLE "tag_asset" DROP COLUMN "updateId";`.execute(db);
  await sql`ALTER TABLE "tag" DROP COLUMN "isHidden";`.execute(db);
  await sql`DROP INDEX "session_viewId_idx";`.execute(db);
  await sql`ALTER TABLE "session" DROP COLUMN "viewId";`.execute(db);
  await sql`ALTER TABLE "session" DROP COLUMN "viewExpiresAt";`.execute(db);
  await sql`DROP TABLE "tag_asset_audit";`.execute(db);
  await sql`DROP TABLE "tag_audit";`.execute(db);
  await sql`DROP TABLE "view_audit";`.execute(db);
  await sql`DROP TABLE "view_tag_audit";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'function_tag_delete_audit';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'function_tag_asset_delete_audit';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'function_tag_asset_after_insert';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'function_tag_asset_after_delete';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'function_view_delete_audit';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'function_view_tag_delete_audit';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_view_delete_audit';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_view_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_view_ownerId_isDefault_uidx';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_tag_delete_audit';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_tag_asset_after_delete';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_tag_asset_after_insert';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_tag_asset_delete_audit';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_view_tag_delete_audit';`.execute(db);
}
