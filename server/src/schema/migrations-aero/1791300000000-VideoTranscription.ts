import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_transcript" (
  "assetId" uuid NOT NULL,
  "language" character varying,
  "modelName" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_transcript_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_transcript_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
  await sql`CREATE TABLE "asset_transcript_segment" (
  "assetId" uuid NOT NULL,
  "index" integer NOT NULL,
  "startTime" integer NOT NULL,
  "endTime" integer NOT NULL,
  "text" text NOT NULL,
  CONSTRAINT "asset_transcript_segment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset_transcript" ("assetId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_transcript_segment_pkey" PRIMARY KEY ("assetId", "index")
);`.execute(db);
  await sql`CREATE INDEX "asset_transcript_segment_text_idx" ON "asset_transcript_segment" USING gin (f_unaccent("text") gin_trgm_ops);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_asset_transcript_segment_text_idx', '{"type":"index","name":"asset_transcript_segment_text_idx","sql":"CREATE INDEX \\"asset_transcript_segment_text_idx\\" ON \\"asset_transcript_segment\\" USING gin (f_unaccent(\\"text\\") gin_trgm_ops);"}'::jsonb);`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_transcript_segment";`.execute(db);
  await sql`DROP TABLE "asset_transcript";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_asset_transcript_segment_text_idx';`.execute(db);
}
