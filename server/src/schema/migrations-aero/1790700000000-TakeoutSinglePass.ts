import { Kysely, sql } from 'kysely';

// Single-pass takeout reading. 1790600000000-TakeoutImport already ran in production and is never edited: every
// change of the single-pass design lives here, and down() restores exactly the shape that migration created.
export async function up(db: Kysely<any>): Promise<void> {
  // takeout_entry is a cache. Rows written by the old pass-1 scan are never mixed with single-pass rows, so all of
  // them go (an export that had a completed run just reads its parts once more and uploads nothing).
  await sql`TRUNCATE "takeout_entry";`.execute(db);
  await sql`ALTER TABLE "takeout_entry" ADD "readError" text, ADD "endOffset" bigint;`.execute(db);
  // (partId, seq) becomes unique: a retried or duplicated flush can never insert a seq twice
  await sql`DROP INDEX "takeout_entry_partId_seq_idx";`.execute(db);
  await sql`ALTER TABLE "takeout_entry" ADD CONSTRAINT "takeout_entry_partId_seq_uq" UNIQUE ("partId", "seq");`.execute(
    db,
  );

  // part: disk presence becomes its own column, the scan state becomes a catalog state
  await sql`ALTER TABLE "takeout_part" ADD "isMissing" boolean NOT NULL DEFAULT false;`.execute(db);
  await sql`UPDATE "takeout_part" SET "isMissing" = true WHERE "scanStatus" = 'missing';`.execute(db);
  await sql`ALTER TABLE "takeout_part"
    DROP COLUMN "scanStatus",
    DROP COLUMN "scanError",
    DROP COLUMN "scanOwner",
    DROP COLUMN "scanStartSize",
    DROP COLUMN "scanStartMtime",
    DROP COLUMN "scanStartCtime",
    DROP COLUMN "scannedSize",
    DROP COLUMN "scannedMtime",
    DROP COLUMN "heartbeatAt",
    DROP COLUMN "attempt",
    DROP COLUMN "bytesScanned",
    ADD "catalogStatus" character varying NOT NULL DEFAULT 'none',
    ADD "catalogVersion" smallint,
    ADD "catalogSize" bigint,
    ADD "catalogMtime" timestamp with time zone,
    ADD "catalogError" text,
    ADD "catalogErrorOffset" bigint,
    ADD "lastReadRunId" uuid,
    ADD "bytesRead" bigint NOT NULL DEFAULT 0;`.execute(db);
  await sql`UPDATE "takeout_part" SET "entryCount" = NULL;`.execute(db);

  // export: the read state is derived from the parts now; the old analysis came from pass-1 catalogs. Exports whose
  // archives were deleted are never analysed again: they keep their analysis (the DTO mapper defaults new fields and
  // drops reasons that no longer exist).
  await sql`ALTER TABLE "takeout_export" DROP COLUMN "scanStatus";`.execute(db);
  await sql`UPDATE "takeout_export" SET "analysis" = '{}', "completeness" = 'unknown', "analyzedAt" = NULL,
    "analysisInputsAt" = now() WHERE "archivesDeletedAt" IS NULL;`.execute(db);

  // run: read statistics, staging ownership (the path is derived from the run id), adoption link
  await sql`ALTER TABLE "takeout_run"
    ADD "readStats" jsonb NOT NULL DEFAULT '{}',
    ADD "hasStaging" boolean NOT NULL DEFAULT false,
    ADD "supersededBy" uuid;`.execute(db);
  // the old scan phases have nothing to lose (plan rows, if any, came from one atomic INSERT): back to queued, boot
  // recovery re-queues them into the new phases
  await sql`UPDATE "takeout_run" SET "status" = 'queued', "leaseToken" = NULL, "heartbeatAt" = NULL
    WHERE "status" IN ('scanning', 'planning');`.execute(db);
  // old importing and finishing runs streamed files in place: the user resumes them (reading is skipped, the boot
  // reclaim step and the repair step take care of their files)
  await sql`UPDATE "takeout_run" SET "status" = 'failed', "leaseToken" = NULL, "heartbeatAt" = NULL,
    "finishedAt" = now(), "error" = 'Interrupted by the upgrade to single-pass reading. Resume to finish.'
    WHERE "status" IN ('importing', 'finishing');`.execute(db);
  // queued and cancelling are left alone: boot recovery runs queued ones and finishes cancelling ones as cancelled

  // run file: the entry position inside its part, for targeted re-reads; (runId, seq) becomes unique
  await sql`ALTER TABLE "takeout_run_file" ADD "entrySeq" integer;`.execute(db);
  await sql`DROP INDEX "takeout_run_file_runId_seq_idx";`.execute(db);
  await sql`ALTER TABLE "takeout_run_file" ADD CONSTRAINT "takeout_run_file_runId_seq_uq" UNIQUE ("runId", "seq");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  // run file: the old enum has no missingFromArchive (mapped, so the report keeps its row count)
  await sql`UPDATE "takeout_run_file" SET "action" = 'partUnreadable' WHERE "action" = 'missingFromArchive';`.execute(
    db,
  );
  await sql`ALTER TABLE "takeout_run_file" DROP CONSTRAINT "takeout_run_file_runId_seq_uq";`.execute(db);
  await sql`CREATE INDEX "takeout_run_file_runId_seq_idx" ON "takeout_run_file" ("runId", "seq");`.execute(db);
  await sql`ALTER TABLE "takeout_run_file" DROP COLUMN "entrySeq";`.execute(db);

  // run: phases the old code does not know
  await sql`UPDATE "takeout_run" SET "status" = 'failed', "leaseToken" = NULL, "heartbeatAt" = NULL,
    "finishedAt" = now(), "error" = 'Interrupted by a downgrade. Resume to continue.'
    WHERE "status" IN ('reading', 'fetching');`.execute(db);
  await sql`ALTER TABLE "takeout_run" DROP COLUMN "readStats", DROP COLUMN "hasStaging", DROP COLUMN "supersededBy";`.execute(
    db,
  );

  await sql`ALTER TABLE "takeout_export" ADD "scanStatus" character varying NOT NULL DEFAULT 'pending';`.execute(db);

  await sql`TRUNCATE "takeout_entry";`.execute(db);
  await sql`ALTER TABLE "takeout_entry" DROP CONSTRAINT "takeout_entry_partId_seq_uq";`.execute(db);
  await sql`CREATE INDEX "takeout_entry_partId_seq_idx" ON "takeout_entry" ("partId", "seq");`.execute(db);
  await sql`ALTER TABLE "takeout_entry" DROP COLUMN "readError", DROP COLUMN "endOffset";`.execute(db);

  await sql`ALTER TABLE "takeout_part"
    ADD "scanStatus" character varying NOT NULL DEFAULT 'pending',
    ADD "scanError" text,
    ADD "scanOwner" uuid,
    ADD "scanStartSize" bigint,
    ADD "scanStartMtime" timestamp with time zone,
    ADD "scanStartCtime" timestamp with time zone,
    ADD "scannedSize" bigint,
    ADD "scannedMtime" timestamp with time zone,
    ADD "heartbeatAt" timestamp with time zone,
    ADD "attempt" integer NOT NULL DEFAULT 0,
    ADD "bytesScanned" bigint NOT NULL DEFAULT 0;`.execute(db);
  await sql`UPDATE "takeout_part" SET "scanStatus" = 'missing' WHERE "isMissing";`.execute(db);
  await sql`ALTER TABLE "takeout_part"
    DROP COLUMN "isMissing",
    DROP COLUMN "catalogStatus",
    DROP COLUMN "catalogVersion",
    DROP COLUMN "catalogSize",
    DROP COLUMN "catalogMtime",
    DROP COLUMN "catalogError",
    DROP COLUMN "catalogErrorOffset",
    DROP COLUMN "lastReadRunId",
    DROP COLUMN "bytesRead";`.execute(db);
}
