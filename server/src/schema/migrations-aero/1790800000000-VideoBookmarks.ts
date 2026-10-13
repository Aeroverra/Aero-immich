import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "video_bookmark" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "assetId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "time" integer NOT NULL,
  "label" character varying NOT NULL DEFAULT '',
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "video_bookmark_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "video_bookmark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "video_bookmark_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "video_bookmark_userId_idx" ON "video_bookmark" ("userId");`.execute(db);
  await sql`CREATE INDEX "video_bookmark_assetId_userId_idx" ON "video_bookmark" ("assetId", "userId");`.execute(db);
  await sql`CREATE INDEX "video_bookmark_updateId_idx" ON "video_bookmark" ("updateId");`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "video_bookmark_updatedAt"
  BEFORE UPDATE ON "video_bookmark"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_video_bookmark_updatedAt', '{"type":"trigger","name":"video_bookmark_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"video_bookmark_updatedAt\\"\\n  BEFORE UPDATE ON \\"video_bookmark\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "video_bookmark";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_video_bookmark_updatedAt';`.execute(db);
}
