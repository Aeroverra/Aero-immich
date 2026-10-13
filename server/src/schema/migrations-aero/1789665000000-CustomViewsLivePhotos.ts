import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION tag_asset_after_insert()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    DECLARE
      asset_ids uuid[];
    BEGIN
      -- a tag change can move an asset in or out of a view; touching the asset and the rows sync sends with it
      -- hands out fresh updateIds, so clients that only receive the default view re-evaluate them. The motion part
      -- of a live photo follows the tags of its still, so it is touched with it.
      SELECT array_agg(DISTINCT "id") INTO asset_ids FROM (
        SELECT "assetId" AS "id" FROM new
        UNION
        SELECT "livePhotoVideoId" FROM asset WHERE "id" IN (SELECT "assetId" FROM new) AND "livePhotoVideoId" IS NOT NULL
      ) AS touched;
      UPDATE asset SET "updatedAt" = clock_timestamp() WHERE "id" = ANY(asset_ids);
      UPDATE asset_exif SET "updatedAt" = clock_timestamp() WHERE "assetId" = ANY(asset_ids);
      UPDATE album_asset SET "updatedAt" = clock_timestamp() WHERE "assetId" = ANY(asset_ids);
      UPDATE stack SET "updatedAt" = clock_timestamp() WHERE "primaryAssetId" = ANY(asset_ids);
      UPDATE asset_face SET "updatedAt" = clock_timestamp() WHERE "assetId" = ANY(asset_ids);
      UPDATE memory_asset SET "updatedAt" = clock_timestamp() WHERE "assetId" = ANY(asset_ids);
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION tag_asset_after_delete()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    DECLARE
      asset_ids uuid[];
    BEGIN
      -- a tag change can move an asset in or out of a view; touching the asset and the rows sync sends with it
      -- hands out fresh updateIds, so clients that only receive the default view re-evaluate them. The motion part
      -- of a live photo follows the tags of its still, so it is touched with it.
      SELECT array_agg(DISTINCT "id") INTO asset_ids FROM (
        SELECT "assetId" AS "id" FROM old
        UNION
        SELECT "livePhotoVideoId" FROM asset WHERE "id" IN (SELECT "assetId" FROM old) AND "livePhotoVideoId" IS NOT NULL
      ) AS touched;
      UPDATE asset SET "updatedAt" = clock_timestamp() WHERE "id" = ANY(asset_ids);
      UPDATE asset_exif SET "updatedAt" = clock_timestamp() WHERE "assetId" = ANY(asset_ids);
      UPDATE album_asset SET "updatedAt" = clock_timestamp() WHERE "assetId" = ANY(asset_ids);
      UPDATE stack SET "updatedAt" = clock_timestamp() WHERE "primaryAssetId" = ANY(asset_ids);
      UPDATE asset_face SET "updatedAt" = clock_timestamp() WHERE "assetId" = ANY(asset_ids);
      UPDATE memory_asset SET "updatedAt" = clock_timestamp() WHERE "assetId" = ANY(asset_ids);
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`UPDATE "migration_overrides" SET "value" = '{"type":"function","name":"tag_asset_after_insert","sql":"CREATE OR REPLACE FUNCTION tag_asset_after_insert()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    DECLARE\\n      asset_ids uuid[];\\n    BEGIN\\n      -- a tag change can move an asset in or out of a view; touching the asset and the rows sync sends with it\\n      -- hands out fresh updateIds, so clients that only receive the default view re-evaluate them. The motion part\\n      -- of a live photo follows the tags of its still, so it is touched with it.\\n      SELECT array_agg(DISTINCT \\"id\\") INTO asset_ids FROM (\\n        SELECT \\"assetId\\" AS \\"id\\" FROM new\\n        UNION\\n        SELECT \\"livePhotoVideoId\\" FROM asset WHERE \\"id\\" IN (SELECT \\"assetId\\" FROM new) AND \\"livePhotoVideoId\\" IS NOT NULL\\n      ) AS touched;\\n      UPDATE asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"id\\" = ANY(asset_ids);\\n      UPDATE asset_exif SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" = ANY(asset_ids);\\n      UPDATE album_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" = ANY(asset_ids);\\n      UPDATE stack SET \\"updatedAt\\" = clock_timestamp() WHERE \\"primaryAssetId\\" = ANY(asset_ids);\\n      UPDATE asset_face SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" = ANY(asset_ids);\\n      UPDATE memory_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" = ANY(asset_ids);\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb WHERE "name" = 'function_tag_asset_after_insert';`.execute(
    db,
  );
  await sql`UPDATE "migration_overrides" SET "value" = '{"type":"function","name":"tag_asset_after_delete","sql":"CREATE OR REPLACE FUNCTION tag_asset_after_delete()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    DECLARE\\n      asset_ids uuid[];\\n    BEGIN\\n      -- a tag change can move an asset in or out of a view; touching the asset and the rows sync sends with it\\n      -- hands out fresh updateIds, so clients that only receive the default view re-evaluate them. The motion part\\n      -- of a live photo follows the tags of its still, so it is touched with it.\\n      SELECT array_agg(DISTINCT \\"id\\") INTO asset_ids FROM (\\n        SELECT \\"assetId\\" AS \\"id\\" FROM old\\n        UNION\\n        SELECT \\"livePhotoVideoId\\" FROM asset WHERE \\"id\\" IN (SELECT \\"assetId\\" FROM old) AND \\"livePhotoVideoId\\" IS NOT NULL\\n      ) AS touched;\\n      UPDATE asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"id\\" = ANY(asset_ids);\\n      UPDATE asset_exif SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" = ANY(asset_ids);\\n      UPDATE album_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" = ANY(asset_ids);\\n      UPDATE stack SET \\"updatedAt\\" = clock_timestamp() WHERE \\"primaryAssetId\\" = ANY(asset_ids);\\n      UPDATE asset_face SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" = ANY(asset_ids);\\n      UPDATE memory_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" = ANY(asset_ids);\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb WHERE "name" = 'function_tag_asset_after_delete';`.execute(
    db,
  );
  // views now evaluate the hidden motion part of a live photo with the tags of its still, so clients limited to the
  // default view re-evaluate the motion parts of every user with a default view
  await sql`WITH motion_parts AS (
    SELECT motion."id" FROM asset motion
    INNER JOIN asset still ON still."livePhotoVideoId" = motion."id"
    WHERE motion."ownerId" IN (SELECT "ownerId" FROM view WHERE "isDefault" = true)
  ), touched_asset AS (
    UPDATE asset SET "updatedAt" = clock_timestamp() WHERE "id" IN (SELECT "id" FROM motion_parts)
  ), touched_exif AS (
    UPDATE asset_exif SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT "id" FROM motion_parts)
  ), touched_album_asset AS (
    UPDATE album_asset SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT "id" FROM motion_parts)
  ), touched_face AS (
    UPDATE asset_face SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT "id" FROM motion_parts)
  )
  UPDATE memory_asset SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT "id" FROM motion_parts);`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION tag_asset_after_insert()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      -- a tag change can move an asset in or out of a view; touching the asset and the rows sync sends with it
      -- hands out fresh updateIds, so clients that only receive the default view re-evaluate them
      UPDATE asset SET "updatedAt" = clock_timestamp() WHERE "id" IN (SELECT DISTINCT "assetId" FROM new);
      UPDATE asset_exif SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM new);
      UPDATE album_asset SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM new);
      UPDATE stack SET "updatedAt" = clock_timestamp() WHERE "primaryAssetId" IN (SELECT DISTINCT "assetId" FROM new);
      UPDATE asset_face SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM new);
      UPDATE memory_asset SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM new);
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION tag_asset_after_delete()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      -- a tag change can move an asset in or out of a view; touching the asset and the rows sync sends with it
      -- hands out fresh updateIds, so clients that only receive the default view re-evaluate them
      UPDATE asset SET "updatedAt" = clock_timestamp() WHERE "id" IN (SELECT DISTINCT "assetId" FROM old);
      UPDATE asset_exif SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM old);
      UPDATE album_asset SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM old);
      UPDATE stack SET "updatedAt" = clock_timestamp() WHERE "primaryAssetId" IN (SELECT DISTINCT "assetId" FROM old);
      UPDATE asset_face SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM old);
      UPDATE memory_asset SET "updatedAt" = clock_timestamp() WHERE "assetId" IN (SELECT DISTINCT "assetId" FROM old);
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`UPDATE "migration_overrides" SET "value" = '{"type":"function","name":"tag_asset_after_insert","sql":"CREATE OR REPLACE FUNCTION tag_asset_after_insert()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      -- a tag change can move an asset in or out of a view; touching the asset and the rows sync sends with it\\n      -- hands out fresh updateIds, so clients that only receive the default view re-evaluate them\\n      UPDATE asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"id\\" IN (SELECT DISTINCT \\"assetId\\" FROM new);\\n      UPDATE asset_exif SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM new);\\n      UPDATE album_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM new);\\n      UPDATE stack SET \\"updatedAt\\" = clock_timestamp() WHERE \\"primaryAssetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM new);\\n      UPDATE asset_face SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM new);\\n      UPDATE memory_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM new);\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb WHERE "name" = 'function_tag_asset_after_insert';`.execute(
    db,
  );
  await sql`UPDATE "migration_overrides" SET "value" = '{"type":"function","name":"tag_asset_after_delete","sql":"CREATE OR REPLACE FUNCTION tag_asset_after_delete()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      -- a tag change can move an asset in or out of a view; touching the asset and the rows sync sends with it\\n      -- hands out fresh updateIds, so clients that only receive the default view re-evaluate them\\n      UPDATE asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"id\\" IN (SELECT DISTINCT \\"assetId\\" FROM old);\\n      UPDATE asset_exif SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM old);\\n      UPDATE album_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM old);\\n      UPDATE stack SET \\"updatedAt\\" = clock_timestamp() WHERE \\"primaryAssetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM old);\\n      UPDATE asset_face SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM old);\\n      UPDATE memory_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"assetId\\" IN (SELECT DISTINCT \\"assetId\\" FROM old);\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb WHERE "name" = 'function_tag_asset_after_delete';`.execute(
    db,
  );
}
