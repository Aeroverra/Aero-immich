import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION preserve_updated_at()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
        IF current_setting('immich.preserve_updated_at', true) = 'on' THEN
            new."updatedAt" = old."updatedAt";
        END IF;
        return new;
    END;
  $$;`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "album_updatedAt_preserve"
  BEFORE UPDATE ON "album"
  FOR EACH ROW
  EXECUTE FUNCTION preserve_updated_at();`.execute(db);
  await sql`CREATE TABLE "album_view_state_checkpoint" (
  "userId" uuid NOT NULL,
  "updateId" uuid NOT NULL,
  CONSTRAINT "album_view_state_checkpoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "album_view_state_checkpoint_pkey" PRIMARY KEY ("userId")
);`.execute(db);
  await sql`CREATE TABLE "album_view_state" (
  "albumId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "isHidden" boolean NOT NULL DEFAULT false,
  "thumbnailAssetId" uuid,
  CONSTRAINT "album_view_state_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "album_view_state_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "album_view_state_thumbnailAssetId_fkey" FOREIGN KEY ("thumbnailAssetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "album_view_state_pkey" PRIMARY KEY ("albumId", "userId")
);`.execute(db);
  await sql`CREATE INDEX "album_view_state_userId_idx" ON "album_view_state" ("userId");`.execute(db);
  await sql`CREATE INDEX "album_view_state_thumbnailAssetId_idx" ON "album_view_state" ("thumbnailAssetId");`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('function_preserve_updated_at', '{"type":"function","name":"preserve_updated_at","sql":"CREATE OR REPLACE FUNCTION preserve_updated_at()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n        IF current_setting(''immich.preserve_updated_at'', true) = ''on'' THEN\\n            new.\\"updatedAt\\" = old.\\"updatedAt\\";\\n        END IF;\\n        return new;\\n    END;\\n  $$;"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_album_updatedAt_preserve', '{"type":"trigger","name":"album_updatedAt_preserve","sql":"CREATE OR REPLACE TRIGGER \\"album_updatedAt_preserve\\"\\n  BEFORE UPDATE ON \\"album\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION preserve_updated_at();"}'::jsonb);`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER "album_updatedAt_preserve" ON "album";`.execute(db);
  await sql`DROP FUNCTION preserve_updated_at;`.execute(db);
  await sql`DROP TABLE "album_view_state_checkpoint";`.execute(db);
  await sql`DROP TABLE "album_view_state";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'function_preserve_updated_at';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_album_updatedAt_preserve';`.execute(db);
}
