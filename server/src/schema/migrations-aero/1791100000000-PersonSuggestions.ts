import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "person_suggestion" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "ownerId" uuid NOT NULL,
  "kind" character varying NOT NULL,
  "source" character varying NOT NULL DEFAULT 'automatic',
  "personGroupId" uuid,
  "faceId" uuid,
  "targetPersonGroupId" uuid NOT NULL,
  "score" real NOT NULL,
  "priority" real NOT NULL DEFAULT 0,
  "status" character varying NOT NULL DEFAULT 'pending',
  "undo" jsonb,
  "answeredAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "person_suggestion_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_suggestion_personGroupId_fkey" FOREIGN KEY ("personGroupId") REFERENCES "person_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_suggestion_faceId_fkey" FOREIGN KEY ("faceId") REFERENCES "asset_face" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_suggestion_targetPersonGroupId_fkey" FOREIGN KEY ("targetPersonGroupId") REFERENCES "person_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_suggestion_candidate_chk" CHECK ("personGroupId" IS NULL OR "faceId" IS NULL),
  CONSTRAINT "person_suggestion_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE UNIQUE INDEX "person_suggestion_ownerId_faceId_target_uq" ON "person_suggestion" ("ownerId", "faceId", "targetPersonGroupId") WHERE ("faceId" IS NOT NULL);`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX "person_suggestion_ownerId_personGroupId_target_uq" ON "person_suggestion" ("ownerId", "personGroupId", "targetPersonGroupId") WHERE ("personGroupId" IS NOT NULL);`.execute(
    db,
  );
  await sql`CREATE INDEX "person_suggestion_ownerId_status_idx" ON "person_suggestion" ("ownerId", "status");`.execute(
    db,
  );
  await sql`CREATE INDEX "person_suggestion_ownerId_idx" ON "person_suggestion" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "person_suggestion_personGroupId_idx" ON "person_suggestion" ("personGroupId");`.execute(db);
  await sql`CREATE INDEX "person_suggestion_faceId_idx" ON "person_suggestion" ("faceId");`.execute(db);
  await sql`CREATE INDEX "person_suggestion_targetPersonGroupId_idx" ON "person_suggestion" ("targetPersonGroupId");`.execute(
    db,
  );
  await sql`CREATE OR REPLACE TRIGGER "person_suggestion_updatedAt"
  BEFORE UPDATE ON "person_suggestion"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_person_suggestion_updatedAt', '{"type":"trigger","name":"person_suggestion_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"person_suggestion_updatedAt\\"\\n  BEFORE UPDATE ON \\"person_suggestion\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_person_suggestion_ownerId_faceId_target_uq', '{"type":"index","name":"person_suggestion_ownerId_faceId_target_uq","sql":"CREATE UNIQUE INDEX \\"person_suggestion_ownerId_faceId_target_uq\\" ON \\"person_suggestion\\" (\\"ownerId\\", \\"faceId\\", \\"targetPersonGroupId\\") WHERE (\\"faceId\\" IS NOT NULL);"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_person_suggestion_ownerId_personGroupId_target_uq', '{"type":"index","name":"person_suggestion_ownerId_personGroupId_target_uq","sql":"CREATE UNIQUE INDEX \\"person_suggestion_ownerId_personGroupId_target_uq\\" ON \\"person_suggestion\\" (\\"ownerId\\", \\"personGroupId\\", \\"targetPersonGroupId\\") WHERE (\\"personGroupId\\" IS NOT NULL);"}'::jsonb);`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "person_suggestion";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_person_suggestion_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_person_suggestion_ownerId_faceId_target_uq';`.execute(
    db,
  );
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_person_suggestion_ownerId_personGroupId_target_uq';`.execute(
    db,
  );
}
