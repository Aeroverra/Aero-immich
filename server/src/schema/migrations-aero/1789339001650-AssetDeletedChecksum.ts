import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_deleted_checksum" (
  "ownerId" uuid NOT NULL,
  "checksum" bytea NOT NULL,
  "assetId" uuid NOT NULL,
  "originalFileName" character varying NOT NULL,
  "deletedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "reimportedAt" timestamp with time zone,
  "reimportMode" character varying,
  "notifiedAt" timestamp with time zone,
  CONSTRAINT "asset_deleted_checksum_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_deleted_checksum_pkey" PRIMARY KEY ("ownerId", "checksum")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_deleted_checksum";`.execute(db);
}
