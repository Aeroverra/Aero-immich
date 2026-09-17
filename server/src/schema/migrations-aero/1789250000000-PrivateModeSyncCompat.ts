import { Kysely, sql } from 'kysely';

// Fork-only: whenever an album flips its private flag, touch its album_asset and album_user rows so their
// updatedAt triggers hand out fresh updateIds. Sync clients that withheld the private album (they were told
// it was deleted, which cascaded to the links they held) get every link back once the album is public again.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION album_asset_private_after_insert()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      -- adding an asset to a private album makes the asset private
      UPDATE asset SET "isPrivate" = true
      WHERE "id" IN (
        SELECT n."assetId" FROM new n
        INNER JOIN album a ON a."id" = n."albumId"
        WHERE a."isPrivate" = true
      ) AND "isPrivate" = false;

      -- adding a private asset makes the album private; its links are touched so sync clients re-evaluate them
      WITH flipped AS (
        UPDATE album SET "isPrivate" = true, "updatedAt" = clock_timestamp(), "updateId" = immich_uuid_v7(clock_timestamp())
        WHERE "id" IN (
          SELECT n."albumId" FROM new n
          INNER JOIN asset s ON s."id" = n."assetId"
          WHERE s."isPrivate" = true AND s."deletedAt" IS NULL
        ) AND "isPrivate" = false
        RETURNING "id"
      ), touched_assets AS (
        UPDATE album_asset SET "updatedAt" = clock_timestamp() WHERE "albumId" IN (SELECT "id" FROM flipped)
      )
      UPDATE album_user SET "updatedAt" = clock_timestamp() WHERE "albumId" IN (SELECT "id" FROM flipped);
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION album_asset_private_after_delete()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      -- removing the last private asset makes the album public; its links are touched so sync clients get them back
      WITH flipped AS (
        UPDATE album SET "isPrivate" = false, "updatedAt" = clock_timestamp(), "updateId" = immich_uuid_v7(clock_timestamp())
        WHERE "id" IN (SELECT DISTINCT "albumId" FROM old)
          AND "isPrivate" = true
          AND NOT EXISTS (
            SELECT FROM album_asset aa
            INNER JOIN asset s ON s."id" = aa."assetId"
            WHERE aa."albumId" = album."id" AND s."isPrivate" = true AND s."deletedAt" IS NULL
          )
        RETURNING "id"
      ), touched_assets AS (
        UPDATE album_asset SET "updatedAt" = clock_timestamp() WHERE "albumId" IN (SELECT "id" FROM flipped)
      )
      UPDATE album_user SET "updatedAt" = clock_timestamp() WHERE "albumId" IN (SELECT "id" FROM flipped);
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION asset_private_after_update()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      -- an album follows its assets; whenever it flips, its links are touched so sync clients re-evaluate them
      WITH flipped AS (
        UPDATE album SET "isPrivate" = true, "updatedAt" = clock_timestamp(), "updateId" = immich_uuid_v7(clock_timestamp())
        WHERE "isPrivate" = false
          AND "id" IN (
            SELECT aa."albumId" FROM new n
            INNER JOIN album_asset aa ON aa."assetId" = n."id"
            WHERE n."isPrivate" = true AND n."deletedAt" IS NULL
          )
        RETURNING "id"
      ), touched_assets AS (
        UPDATE album_asset SET "updatedAt" = clock_timestamp() WHERE "albumId" IN (SELECT "id" FROM flipped)
      )
      UPDATE album_user SET "updatedAt" = clock_timestamp() WHERE "albumId" IN (SELECT "id" FROM flipped);

      WITH flipped AS (
        UPDATE album SET "isPrivate" = false, "updatedAt" = clock_timestamp(), "updateId" = immich_uuid_v7(clock_timestamp())
        WHERE "isPrivate" = true
          AND "id" IN (SELECT aa."albumId" FROM new n INNER JOIN album_asset aa ON aa."assetId" = n."id")
          AND NOT EXISTS (
            SELECT FROM album_asset aa
            INNER JOIN asset s ON s."id" = aa."assetId"
            WHERE aa."albumId" = album."id" AND s."isPrivate" = true AND s."deletedAt" IS NULL
          )
        RETURNING "id"
      ), touched_assets AS (
        UPDATE album_asset SET "updatedAt" = clock_timestamp() WHERE "albumId" IN (SELECT "id" FROM flipped)
      )
      UPDATE album_user SET "updatedAt" = clock_timestamp() WHERE "albumId" IN (SELECT "id" FROM flipped);
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`UPDATE "migration_overrides" SET "value" = '{"type":"function","name":"album_asset_private_after_insert","sql":"CREATE OR REPLACE FUNCTION album_asset_private_after_insert()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      -- adding an asset to a private album makes the asset private\\n      UPDATE asset SET \\"isPrivate\\" = true\\n      WHERE \\"id\\" IN (\\n        SELECT n.\\"assetId\\" FROM new n\\n        INNER JOIN album a ON a.\\"id\\" = n.\\"albumId\\"\\n        WHERE a.\\"isPrivate\\" = true\\n      ) AND \\"isPrivate\\" = false;\\n\\n      -- adding a private asset makes the album private; its links are touched so sync clients re-evaluate them\\n      WITH flipped AS (\\n        UPDATE album SET \\"isPrivate\\" = true, \\"updatedAt\\" = clock_timestamp(), \\"updateId\\" = immich_uuid_v7(clock_timestamp())\\n        WHERE \\"id\\" IN (\\n          SELECT n.\\"albumId\\" FROM new n\\n          INNER JOIN asset s ON s.\\"id\\" = n.\\"assetId\\"\\n          WHERE s.\\"isPrivate\\" = true AND s.\\"deletedAt\\" IS NULL\\n        ) AND \\"isPrivate\\" = false\\n        RETURNING \\"id\\"\\n      ), touched_assets AS (\\n        UPDATE album_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"albumId\\" IN (SELECT \\"id\\" FROM flipped)\\n      )\\n      UPDATE album_user SET \\"updatedAt\\" = clock_timestamp() WHERE \\"albumId\\" IN (SELECT \\"id\\" FROM flipped);\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb WHERE "name" = 'function_album_asset_private_after_insert';`.execute(db);
  await sql`UPDATE "migration_overrides" SET "value" = '{"type":"function","name":"album_asset_private_after_delete","sql":"CREATE OR REPLACE FUNCTION album_asset_private_after_delete()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      -- removing the last private asset makes the album public; its links are touched so sync clients get them back\\n      WITH flipped AS (\\n        UPDATE album SET \\"isPrivate\\" = false, \\"updatedAt\\" = clock_timestamp(), \\"updateId\\" = immich_uuid_v7(clock_timestamp())\\n        WHERE \\"id\\" IN (SELECT DISTINCT \\"albumId\\" FROM old)\\n          AND \\"isPrivate\\" = true\\n          AND NOT EXISTS (\\n            SELECT FROM album_asset aa\\n            INNER JOIN asset s ON s.\\"id\\" = aa.\\"assetId\\"\\n            WHERE aa.\\"albumId\\" = album.\\"id\\" AND s.\\"isPrivate\\" = true AND s.\\"deletedAt\\" IS NULL\\n          )\\n        RETURNING \\"id\\"\\n      ), touched_assets AS (\\n        UPDATE album_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"albumId\\" IN (SELECT \\"id\\" FROM flipped)\\n      )\\n      UPDATE album_user SET \\"updatedAt\\" = clock_timestamp() WHERE \\"albumId\\" IN (SELECT \\"id\\" FROM flipped);\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb WHERE "name" = 'function_album_asset_private_after_delete';`.execute(db);
  await sql`UPDATE "migration_overrides" SET "value" = '{"type":"function","name":"asset_private_after_update","sql":"CREATE OR REPLACE FUNCTION asset_private_after_update()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      -- an album follows its assets; whenever it flips, its links are touched so sync clients re-evaluate them\\n      WITH flipped AS (\\n        UPDATE album SET \\"isPrivate\\" = true, \\"updatedAt\\" = clock_timestamp(), \\"updateId\\" = immich_uuid_v7(clock_timestamp())\\n        WHERE \\"isPrivate\\" = false\\n          AND \\"id\\" IN (\\n            SELECT aa.\\"albumId\\" FROM new n\\n            INNER JOIN album_asset aa ON aa.\\"assetId\\" = n.\\"id\\"\\n            WHERE n.\\"isPrivate\\" = true AND n.\\"deletedAt\\" IS NULL\\n          )\\n        RETURNING \\"id\\"\\n      ), touched_assets AS (\\n        UPDATE album_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"albumId\\" IN (SELECT \\"id\\" FROM flipped)\\n      )\\n      UPDATE album_user SET \\"updatedAt\\" = clock_timestamp() WHERE \\"albumId\\" IN (SELECT \\"id\\" FROM flipped);\\n\\n      WITH flipped AS (\\n        UPDATE album SET \\"isPrivate\\" = false, \\"updatedAt\\" = clock_timestamp(), \\"updateId\\" = immich_uuid_v7(clock_timestamp())\\n        WHERE \\"isPrivate\\" = true\\n          AND \\"id\\" IN (SELECT aa.\\"albumId\\" FROM new n INNER JOIN album_asset aa ON aa.\\"assetId\\" = n.\\"id\\")\\n          AND NOT EXISTS (\\n            SELECT FROM album_asset aa\\n            INNER JOIN asset s ON s.\\"id\\" = aa.\\"assetId\\"\\n            WHERE aa.\\"albumId\\" = album.\\"id\\" AND s.\\"isPrivate\\" = true AND s.\\"deletedAt\\" IS NULL\\n          )\\n        RETURNING \\"id\\"\\n      ), touched_assets AS (\\n        UPDATE album_asset SET \\"updatedAt\\" = clock_timestamp() WHERE \\"albumId\\" IN (SELECT \\"id\\" FROM flipped)\\n      )\\n      UPDATE album_user SET \\"updatedAt\\" = clock_timestamp() WHERE \\"albumId\\" IN (SELECT \\"id\\" FROM flipped);\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb WHERE "name" = 'function_asset_private_after_update';`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION album_asset_private_after_insert()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      -- adding an asset to a private album makes the asset private
      UPDATE asset SET "isPrivate" = true
      WHERE "id" IN (
        SELECT n."assetId" FROM new n
        INNER JOIN album a ON a."id" = n."albumId"
        WHERE a."isPrivate" = true
      ) AND "isPrivate" = false;

      -- adding a private asset makes the album private
      UPDATE album SET "isPrivate" = true, "updatedAt" = clock_timestamp(), "updateId" = immich_uuid_v7(clock_timestamp())
      WHERE "id" IN (
        SELECT n."albumId" FROM new n
        INNER JOIN asset s ON s."id" = n."assetId"
        WHERE s."isPrivate" = true AND s."deletedAt" IS NULL
      ) AND "isPrivate" = false;
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION album_asset_private_after_delete()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      UPDATE album SET "isPrivate" = false, "updatedAt" = clock_timestamp(), "updateId" = immich_uuid_v7(clock_timestamp())
      WHERE "id" IN (SELECT DISTINCT "albumId" FROM old)
        AND "isPrivate" = true
        AND NOT EXISTS (
          SELECT FROM album_asset aa
          INNER JOIN asset s ON s."id" = aa."assetId"
          WHERE aa."albumId" = album."id" AND s."isPrivate" = true AND s."deletedAt" IS NULL
        );
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION asset_private_after_update()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      UPDATE album SET "isPrivate" = true, "updatedAt" = clock_timestamp(), "updateId" = immich_uuid_v7(clock_timestamp())
      WHERE "isPrivate" = false
        AND "id" IN (
          SELECT aa."albumId" FROM new n
          INNER JOIN album_asset aa ON aa."assetId" = n."id"
          WHERE n."isPrivate" = true AND n."deletedAt" IS NULL
        );

      UPDATE album SET "isPrivate" = false, "updatedAt" = clock_timestamp(), "updateId" = immich_uuid_v7(clock_timestamp())
      WHERE "isPrivate" = true
        AND "id" IN (SELECT aa."albumId" FROM new n INNER JOIN album_asset aa ON aa."assetId" = n."id")
        AND NOT EXISTS (
          SELECT FROM album_asset aa
          INNER JOIN asset s ON s."id" = aa."assetId"
          WHERE aa."albumId" = album."id" AND s."isPrivate" = true AND s."deletedAt" IS NULL
        );
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`UPDATE "migration_overrides" SET "value" = '{"type":"function","name":"album_asset_private_after_insert","sql":"CREATE OR REPLACE FUNCTION album_asset_private_after_insert()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      -- adding an asset to a private album makes the asset private\\n      UPDATE asset SET \\"isPrivate\\" = true\\n      WHERE \\"id\\" IN (\\n        SELECT n.\\"assetId\\" FROM new n\\n        INNER JOIN album a ON a.\\"id\\" = n.\\"albumId\\"\\n        WHERE a.\\"isPrivate\\" = true\\n      ) AND \\"isPrivate\\" = false;\\n\\n      -- adding a private asset makes the album private\\n      UPDATE album SET \\"isPrivate\\" = true, \\"updatedAt\\" = clock_timestamp(), \\"updateId\\" = immich_uuid_v7(clock_timestamp())\\n      WHERE \\"id\\" IN (\\n        SELECT n.\\"albumId\\" FROM new n\\n        INNER JOIN asset s ON s.\\"id\\" = n.\\"assetId\\"\\n        WHERE s.\\"isPrivate\\" = true AND s.\\"deletedAt\\" IS NULL\\n      ) AND \\"isPrivate\\" = false;\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb WHERE "name" = 'function_album_asset_private_after_insert';`.execute(db);
  await sql`UPDATE "migration_overrides" SET "value" = '{"type":"function","name":"album_asset_private_after_delete","sql":"CREATE OR REPLACE FUNCTION album_asset_private_after_delete()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      UPDATE album SET \\"isPrivate\\" = false, \\"updatedAt\\" = clock_timestamp(), \\"updateId\\" = immich_uuid_v7(clock_timestamp())\\n      WHERE \\"id\\" IN (SELECT DISTINCT \\"albumId\\" FROM old)\\n        AND \\"isPrivate\\" = true\\n        AND NOT EXISTS (\\n          SELECT FROM album_asset aa\\n          INNER JOIN asset s ON s.\\"id\\" = aa.\\"assetId\\"\\n          WHERE aa.\\"albumId\\" = album.\\"id\\" AND s.\\"isPrivate\\" = true AND s.\\"deletedAt\\" IS NULL\\n        );\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb WHERE "name" = 'function_album_asset_private_after_delete';`.execute(db);
  await sql`UPDATE "migration_overrides" SET "value" = '{"type":"function","name":"asset_private_after_update","sql":"CREATE OR REPLACE FUNCTION asset_private_after_update()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      UPDATE album SET \\"isPrivate\\" = true, \\"updatedAt\\" = clock_timestamp(), \\"updateId\\" = immich_uuid_v7(clock_timestamp())\\n      WHERE \\"isPrivate\\" = false\\n        AND \\"id\\" IN (\\n          SELECT aa.\\"albumId\\" FROM new n\\n          INNER JOIN album_asset aa ON aa.\\"assetId\\" = n.\\"id\\"\\n          WHERE n.\\"isPrivate\\" = true AND n.\\"deletedAt\\" IS NULL\\n        );\\n\\n      UPDATE album SET \\"isPrivate\\" = false, \\"updatedAt\\" = clock_timestamp(), \\"updateId\\" = immich_uuid_v7(clock_timestamp())\\n      WHERE \\"isPrivate\\" = true\\n        AND \\"id\\" IN (SELECT aa.\\"albumId\\" FROM new n INNER JOIN album_asset aa ON aa.\\"assetId\\" = n.\\"id\\")\\n        AND NOT EXISTS (\\n          SELECT FROM album_asset aa\\n          INNER JOIN asset s ON s.\\"id\\" = aa.\\"assetId\\"\\n          WHERE aa.\\"albumId\\" = album.\\"id\\" AND s.\\"isPrivate\\" = true AND s.\\"deletedAt\\" IS NULL\\n        );\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb WHERE "name" = 'function_asset_private_after_update';`.execute(db);
}
