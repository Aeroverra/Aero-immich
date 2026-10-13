import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "takeout_export" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "userId" uuid NOT NULL,
  "exportKey" character varying NOT NULL,
  "exportedAt" timestamp with time zone NOT NULL,
  "splitSize" bigint,
  "completeness" character varying NOT NULL DEFAULT 'unknown',
  "scanStatus" character varying NOT NULL DEFAULT 'pending',
  "indexFileName" character varying,
  "accountEmail" character varying,
  "googleJobId" character varying,
  "indexTotalSize" character varying,
  "indexFileCount" integer,
  "indexCreatedText" character varying,
  "analysis" jsonb NOT NULL DEFAULT '{}',
  "analysisInputsAt" timestamp with time zone,
  "analyzedAt" timestamp with time zone,
  "archivesDeletedAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "takeout_export_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_export_userId_exportKey_uq" UNIQUE ("userId", "exportKey"),
  CONSTRAINT "takeout_export_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE TABLE "takeout_part" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "exportId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "fileName" character varying NOT NULL,
  "timestamp" character varying NOT NULL,
  "segment" integer,
  "partNumber" integer NOT NULL,
  "kind" character varying NOT NULL,
  "isIndex" boolean NOT NULL DEFAULT false,
  "size" bigint NOT NULL,
  "mtime" timestamp with time zone NOT NULL,
  "ctime" timestamp with time zone NOT NULL,
  "prevSyncSize" bigint,
  "scanStatus" character varying NOT NULL DEFAULT 'pending',
  "scanError" text,
  "scanOwner" uuid,
  "scanStartSize" bigint,
  "scanStartMtime" timestamp with time zone,
  "scanStartCtime" timestamp with time zone,
  "scannedSize" bigint,
  "scannedMtime" timestamp with time zone,
  "heartbeatAt" timestamp with time zone,
  "attempt" integer NOT NULL DEFAULT 0,
  "bytesScanned" bigint NOT NULL DEFAULT 0,
  "entryCount" integer,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "takeout_part_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "takeout_export" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_part_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_part_userId_fileName_uq" UNIQUE ("userId", "fileName"),
  CONSTRAINT "takeout_part_exportId_fileName_uq" UNIQUE ("exportId", "fileName"),
  CONSTRAINT "takeout_part_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE TABLE "takeout_entry" (
  "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  "exportId" uuid NOT NULL,
  "partId" uuid NOT NULL,
  "seq" integer NOT NULL,
  "path" text NOT NULL,
  "size" bigint NOT NULL,
  "mtime" timestamp with time zone,
  "kind" character varying NOT NULL,
  "checksum" bytea,
  "json" jsonb,
  "jsonError" text,
  "width" integer,
  "height" integer,
  "sample" bytea,
  "sampleSkipped" character varying,
  CONSTRAINT "takeout_entry_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "takeout_export" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_entry_partId_fkey" FOREIGN KEY ("partId") REFERENCES "takeout_part" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_entry_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "takeout_entry_partId_seq_idx" ON "takeout_entry" ("partId", "seq");`.execute(db);
  await sql`CREATE INDEX "takeout_entry_exportId_idx" ON "takeout_entry" ("exportId");`.execute(db);
  await sql`CREATE TABLE "takeout_folder" (
  "userId" uuid NOT NULL,
  "folderName" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "takeout_folder_folderName_uq" UNIQUE ("folderName"),
  CONSTRAINT "takeout_folder_pkey" PRIMARY KEY ("userId")
);`.execute(db);
  await sql`CREATE TABLE "takeout_run" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "userId" uuid NOT NULL,
  "exportId" uuid NOT NULL,
  "status" character varying NOT NULL DEFAULT 'queued',
  "importAnyway" boolean NOT NULL DEFAULT false,
  "settings" jsonb NOT NULL,
  "templateVars" jsonb NOT NULL,
  "counters" jsonb NOT NULL DEFAULT '{}',
  "bytesTotal" bigint NOT NULL DEFAULT 0,
  "bytesDone" bigint NOT NULL DEFAULT 0,
  "archiveBytesTotal" bigint NOT NULL DEFAULT 0,
  "archiveBytesRead" bigint NOT NULL DEFAULT 0,
  "currentFile" text,
  "error" text,
  "heartbeatAt" timestamp with time zone,
  "leaseToken" uuid,
  "attempt" integer NOT NULL DEFAULT 0,
  "startedAt" timestamp with time zone,
  "finishedAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "takeout_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_run_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "takeout_export" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_run_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "takeout_run_userId_idx" ON "takeout_run" ("userId");`.execute(db);
  await sql`CREATE INDEX "takeout_run_exportId_idx" ON "takeout_run" ("exportId");`.execute(db);
  await sql`CREATE TABLE "takeout_larger_version" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "userId" uuid NOT NULL,
  "runId" uuid,
  "largerAssetId" uuid NOT NULL,
  "smallerAssetId" uuid,
  "status" character varying NOT NULL DEFAULT 'pending',
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "resolvedAt" timestamp with time zone,
  CONSTRAINT "takeout_larger_version_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_larger_version_runId_fkey" FOREIGN KEY ("runId") REFERENCES "takeout_run" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "takeout_larger_version_largerAssetId_fkey" FOREIGN KEY ("largerAssetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_larger_version_smallerAssetId_fkey" FOREIGN KEY ("smallerAssetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "takeout_larger_version_largerAssetId_smallerAssetId_uq" UNIQUE ("largerAssetId", "smallerAssetId"),
  CONSTRAINT "takeout_larger_version_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "takeout_larger_version_userId_status_idx" ON "takeout_larger_version" ("userId", "status");`.execute(
    db,
  );
  await sql`CREATE INDEX "takeout_larger_version_runId_idx" ON "takeout_larger_version" ("runId");`.execute(db);
  await sql`CREATE INDEX "takeout_larger_version_smallerAssetId_idx" ON "takeout_larger_version" ("smallerAssetId");`.execute(
    db,
  );
  await sql`CREATE TABLE "takeout_run_file" (
  "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  "runId" uuid NOT NULL,
  "seq" integer NOT NULL,
  "takeoutPath" text NOT NULL,
  "partName" character varying,
  "size" bigint NOT NULL,
  "mtime" timestamp with time zone,
  "checksum" bytea,
  "fileKind" character varying NOT NULL,
  "jsonPath" text,
  "matcher" character varying,
  "originalFileName" text,
  "groupIndex" integer,
  "groupOrder" integer,
  "groupKind" character varying,
  "isCover" boolean NOT NULL DEFAULT false,
  "action" character varying NOT NULL,
  "status" character varying NOT NULL,
  "reason" text,
  "plan" jsonb,
  "dependsOnSeq" integer,
  "newAssetId" uuid,
  "assetId" uuid,
  "smallerAssetId" uuid,
  "targetPath" text,
  "captureDate" timestamp with time zone,
  "zone" character varying,
  "zoneSource" character varying,
  "fallbacks" text[] NOT NULL DEFAULT '{}',
  "rotation" smallint NOT NULL DEFAULT 0,
  "rotationState" character varying,
  "error" text,
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "takeout_run_file_runId_fkey" FOREIGN KEY ("runId") REFERENCES "takeout_run" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_run_file_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "takeout_run_file_smallerAssetId_fkey" FOREIGN KEY ("smallerAssetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "takeout_run_file_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "takeout_run_file_runId_groupIndex_idx" ON "takeout_run_file" ("runId", "groupIndex");`.execute(
    db,
  );
  await sql`CREATE INDEX "takeout_run_file_runId_seq_idx" ON "takeout_run_file" ("runId", "seq");`.execute(db);
  await sql`CREATE INDEX "takeout_run_file_assetId_idx" ON "takeout_run_file" ("assetId");`.execute(db);
  await sql`CREATE INDEX "takeout_run_file_smallerAssetId_idx" ON "takeout_run_file" ("smallerAssetId");`.execute(db);
  await sql`CREATE TABLE "takeout_settings" (
  "userId" uuid NOT NULL,
  "settings" jsonb NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "takeout_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_settings_pkey" PRIMARY KEY ("userId")
);`.execute(db);
  await sql`CREATE TABLE "takeout_upload" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "userId" uuid NOT NULL,
  "fileName" character varying NOT NULL,
  "size" bigint NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "takeout_upload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_upload_userId_fileName_uq" UNIQUE ("userId", "fileName"),
  CONSTRAINT "takeout_upload_pkey" PRIMARY KEY ("id")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "takeout_larger_version";`.execute(db);
  await sql`DROP TABLE "takeout_run_file";`.execute(db);
  await sql`DROP TABLE "takeout_run";`.execute(db);
  await sql`DROP TABLE "takeout_entry";`.execute(db);
  await sql`DROP TABLE "takeout_part";`.execute(db);
  await sql`DROP TABLE "takeout_export";`.execute(db);
  await sql`DROP TABLE "takeout_upload";`.execute(db);
  await sql`DROP TABLE "takeout_settings";`.execute(db);
  await sql`DROP TABLE "takeout_folder";`.execute(db);
}
