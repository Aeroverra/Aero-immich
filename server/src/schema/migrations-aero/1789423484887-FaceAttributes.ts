import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_face_attribute" (
  "faceId" uuid NOT NULL,
  "eyeBlinkLeft" real,
  "eyeBlinkRight" real,
  "smile" real,
  "yaw" real,
  "pitch" real,
  "roll" real,
  "sharpness" real,
  "detected" boolean NOT NULL,
  "modelName" text NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_face_attribute_faceId_fkey" FOREIGN KEY ("faceId") REFERENCES "asset_face" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_face_attribute_pkey" PRIMARY KEY ("faceId")
);`.execute(db);
  await sql`CREATE TABLE "asset_quality" (
  "assetId" uuid NOT NULL,
  "sharpness" real NOT NULL,
  "exposureClipped" real NOT NULL,
  "brightness" real NOT NULL,
  "modelName" text NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_quality_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_quality_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_quality";`.execute(db);
  await sql`DROP TABLE "asset_face_attribute";`.execute(db);
}
