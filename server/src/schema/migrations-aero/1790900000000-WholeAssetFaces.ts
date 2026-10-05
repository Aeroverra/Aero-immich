import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // a face that marks a person as being somewhere in the asset, without a location in the picture
  await sql`ALTER TABLE "asset_face" ADD "isWholeAsset" boolean NOT NULL DEFAULT false;`.execute(db);

  // people added to whole videos before this column existed have a manual face covering the whole frame
  await sql`
    UPDATE "asset_face" AS "face"
    SET "isWholeAsset" = true
    FROM "asset"
    WHERE "asset"."id" = "face"."assetId"
      AND "asset"."type" = 'VIDEO'
      AND "face"."sourceType" = 'manual'
      AND "face"."frameTimestamp" IS NULL
      AND "face"."boundingBoxX1" = 0
      AND "face"."boundingBoxY1" = 0
      AND "face"."boundingBoxX2" = "face"."imageWidth"
      AND "face"."boundingBoxY2" = "face"."imageHeight";`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_face" DROP COLUMN "isWholeAsset";`.execute(db);
}
