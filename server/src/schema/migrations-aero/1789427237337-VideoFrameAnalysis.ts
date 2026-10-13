import { Kysely, sql } from 'kysely';
import { getVectorExtension } from 'src/repositories/database.repository';
import { vectorIndexQuery } from 'src/utils/database';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_face" ADD "frameTimestamp" integer;`.execute(db);
  await sql`ALTER TABLE "asset_job_status" ADD "videoFramesAnalyzedAt" timestamp with time zone;`.execute(db);

  // frame embeddings come from the same CLIP model as smart_search, so they share its dimension
  const { rows } = await sql<{ type: string }>`
    SELECT format_type(atttypid, atttypmod) AS "type"
    FROM pg_attribute
    WHERE attrelid = 'smart_search'::regclass AND attname = 'embedding'`.execute(db);
  const embeddingType = rows[0]?.type ?? 'vector(512)';

  await sql`CREATE TABLE "smart_search_frame" (
  "assetId" uuid NOT NULL,
  "frameTimestamp" integer NOT NULL,
  "embedding" ${sql.raw(embeddingType)} NOT NULL,
  CONSTRAINT "smart_search_frame_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "smart_search_frame_pkey" PRIMARY KEY ("assetId", "frameTimestamp")
);`.execute(db);
  await sql`ALTER TABLE "smart_search_frame" ALTER COLUMN "embedding" SET STORAGE EXTERNAL;`.execute(db);

  const vectorExtension = await getVectorExtension(db);
  await sql
    .raw(vectorIndexQuery({ vectorExtension, table: 'smart_search_frame', indexName: 'clip_frame_index' }))
    .execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "smart_search_frame";`.execute(db);
  await sql`ALTER TABLE "asset_job_status" DROP COLUMN "videoFramesAnalyzedAt";`.execute(db);
  await sql`ALTER TABLE "asset_face" DROP COLUMN "frameTimestamp";`.execute(db);
}
