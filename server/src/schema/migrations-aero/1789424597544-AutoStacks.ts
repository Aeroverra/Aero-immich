import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE INDEX "asset_ownerId_fileCreatedAt_idx" ON "asset" ("ownerId", "fileCreatedAt");`.execute(db);
  await sql`ALTER TABLE "asset_job_status" ADD "autoStackedAt" timestamp with time zone;`.execute(db);
  await sql`CREATE TABLE "stack_auto_exclusion" (
  "assetId" uuid NOT NULL,
  "ownerId" uuid NOT NULL,
  "reason" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "stack_auto_exclusion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "stack_auto_exclusion_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "stack_auto_exclusion_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
  await sql`CREATE INDEX "stack_auto_exclusion_ownerId_idx" ON "stack_auto_exclusion" ("ownerId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "asset_ownerId_fileCreatedAt_idx";`.execute(db);
  await sql`ALTER TABLE "asset_job_status" DROP COLUMN "autoStackedAt";`.execute(db);
  await sql`DROP TABLE "stack_auto_exclusion";`.execute(db);
}
