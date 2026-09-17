import { registerFunction } from '@immich/sql-tools';

export const immich_uuid_v7 = registerFunction({
  name: 'immich_uuid_v7',
  arguments: ['p_timestamp timestamp with time zone default clock_timestamp()'],
  returnType: 'uuid',
  language: 'SQL',
  behavior: 'volatile',
  body: `
    SELECT encode(
      set_bit(
        set_bit(
          overlay(uuid_send(gen_random_uuid())
                  placing substring(int8send(floor(extract(epoch from p_timestamp) * 1000)::bigint) from 3)
                  from 1 for 6
          ),
          52, 1
        ),
        53, 1
      ),
      'hex')::uuid;
`,
});

export const album_user_after_insert = registerFunction({
  name: 'album_user_after_insert',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      UPDATE album SET "updatedAt" = clock_timestamp(), "updateId" = immich_uuid_v7(clock_timestamp())
      WHERE "id" IN (SELECT "albumId" FROM inserted_rows)
        AND NOT EXISTS (SELECT FROM inserted_rows WHERE role = 'owner');
      RETURN NULL;
    END`,
});

export const album_asset_private_after_insert = registerFunction({
  name: 'album_asset_private_after_insert',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
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
    END`,
});

export const album_asset_private_after_delete = registerFunction({
  name: 'album_asset_private_after_delete',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
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
    END`,
});

export const asset_private_after_update = registerFunction({
  name: 'asset_private_after_update',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
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
    END`,
});

export const updated_at = registerFunction({
  name: 'updated_at',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    DECLARE
        clock_timestamp TIMESTAMP := clock_timestamp();
    BEGIN
        new."updatedAt" = clock_timestamp;
        new."updateId" = immich_uuid_v7(clock_timestamp);
        return new;
    END;`,
});

export const f_concat_ws = registerFunction({
  name: 'f_concat_ws',
  arguments: ['text', 'text[]'],
  returnType: 'text',
  language: 'SQL',
  parallel: 'safe',
  behavior: 'immutable',
  body: `SELECT array_to_string($2, $1)`,
});

export const f_unaccent = registerFunction({
  name: 'f_unaccent',
  arguments: ['text'],
  returnType: 'text',
  language: 'SQL',
  parallel: 'safe',
  strict: true,
  behavior: 'immutable',
  return: `unaccent('unaccent', $1)`,
});

export const ll_to_earth_public = registerFunction({
  name: 'll_to_earth_public',
  arguments: ['latitude double precision', 'longitude double precision'],
  returnType: 'public.earth',
  language: 'SQL',
  parallel: 'safe',
  strict: true,
  behavior: 'immutable',
  body: `SELECT public.cube(public.cube(public.cube(public.earth()*cos(radians(latitude))*cos(radians(longitude))),public.earth()*cos(radians(latitude))*sin(radians(longitude))),public.earth()*sin(radians(latitude)))::public.earth`,
});

export const user_delete_audit = registerFunction({
  name: 'user_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO user_audit ("userId")
      SELECT "id"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const partner_delete_audit = registerFunction({
  name: 'partner_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO partner_audit ("sharedById", "sharedWithId")
      SELECT "sharedById", "sharedWithId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const asset_delete_audit = registerFunction({
  name: 'asset_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO asset_audit ("assetId", "ownerId")
      SELECT "id", "ownerId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const album_asset_delete_audit = registerFunction({
  name: 'album_asset_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO album_asset_audit ("albumId", "assetId")
      SELECT "albumId", "assetId" FROM OLD
      WHERE "albumId" IN (SELECT "id" FROM album WHERE "id" IN (SELECT "albumId" FROM OLD));
      RETURN NULL;
    END`,
});

export const album_user_delete = registerFunction({
  name: 'album_user_delete',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      DELETE FROM "album"
      WHERE "album"."id" = OLD."albumId"
      AND NOT EXISTS (SELECT "albumId" FROM "album_user" WHERE "album_user"."albumId" = "album"."id" AND "album_user"."role" = 'owner');

      RETURN NULL;
    END`,
});

export const album_user_delete_audit = registerFunction({
  name: 'album_user_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO album_audit ("albumId", "userId")
      SELECT "albumId", "userId"
      FROM OLD;

      IF pg_trigger_depth() = 1 THEN
        INSERT INTO album_user_audit ("albumId", "userId")
        SELECT "albumId", "userId"
        FROM OLD;
      END IF;

      RETURN NULL;
    END`,
});

export const memory_delete_audit = registerFunction({
  name: 'memory_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO memory_audit ("memoryId", "userId")
      SELECT "id", "ownerId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const memory_asset_delete_audit = registerFunction({
  name: 'memory_asset_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO memory_asset_audit ("memoryId", "assetId")
      SELECT "memoriesId", "assetId" FROM OLD
      WHERE "memoriesId" IN (SELECT "id" FROM memory WHERE "id" IN (SELECT "memoriesId" FROM OLD));
      RETURN NULL;
    END`,
});

export const stack_delete_audit = registerFunction({
  name: 'stack_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO stack_audit ("stackId", "userId")
      SELECT "id", "ownerId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const person_delete_audit = registerFunction({
  name: 'person_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO person_audit ("personGroupId", "ownerId")
      SELECT "personGroupId", "ownerId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const person_group_delete_audit = registerFunction({
  name: 'person_group_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO person_group_audit ("personGroupId", "clusterGroupId")
      SELECT "id", "clusterGroupId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const user_metadata_audit = registerFunction({
  name: 'user_metadata_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO user_metadata_audit ("userId", "key")
      SELECT "userId", "key"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const asset_metadata_audit = registerFunction({
  name: 'asset_metadata_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO asset_metadata_audit ("assetId", "key")
      SELECT "assetId", "key"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const asset_face_audit = registerFunction({
  name: 'asset_face_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO asset_face_audit ("assetFaceId", "assetId")
      SELECT "id", "assetId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const asset_edit_insert = registerFunction({
  name: 'asset_edit_insert',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      UPDATE asset
      SET "isEdited" = true
      FROM inserted_edit
      WHERE asset.id = inserted_edit."assetId" AND NOT asset."isEdited";
      RETURN NULL;
    END
  `,
});

export const asset_edit_delete = registerFunction({
  name: 'asset_edit_delete',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      UPDATE asset
      SET "isEdited" = false
      FROM deleted_edit
      WHERE asset.id = deleted_edit."assetId" AND asset."isEdited"
        AND NOT EXISTS (SELECT FROM asset_edit edit WHERE edit."assetId" = asset.id);
      RETURN NULL;
    END
  `,
});

export const asset_edit_audit = registerFunction({
  name: 'asset_edit_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO asset_edit_audit ("editId", "assetId")
      SELECT "id", "assetId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const asset_ocr_delete_audit = registerFunction({
  name: 'asset_ocr_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO asset_ocr_audit ("assetId")
      SELECT "assetId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const tag_delete_audit = registerFunction({
  name: 'tag_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO tag_audit ("tagId", "userId")
      SELECT "id", "userId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const tag_asset_delete_audit = registerFunction({
  name: 'tag_asset_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO tag_asset_audit ("tagId", "assetId", "userId")
      SELECT o."tagId", o."assetId", t."userId" FROM OLD o
      INNER JOIN tag t ON t."id" = o."tagId"
      WHERE o."assetId" IN (SELECT "id" FROM asset WHERE "id" IN (SELECT "assetId" FROM OLD));
      RETURN NULL;
    END`,
});

export const tag_asset_after_insert = registerFunction({
  name: 'tag_asset_after_insert',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
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
    END`,
});

export const tag_asset_after_delete = registerFunction({
  name: 'tag_asset_after_delete',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
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
    END`,
});

export const view_delete_audit = registerFunction({
  name: 'view_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO view_audit ("viewId", "userId")
      SELECT "id", "ownerId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const view_tag_delete_audit = registerFunction({
  name: 'view_tag_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO view_tag_audit ("viewId", "tagId", "userId")
      SELECT o."viewId", o."tagId", v."ownerId" FROM OLD o
      INNER JOIN view v ON v."id" = o."viewId"
      WHERE o."tagId" IN (SELECT "id" FROM tag WHERE "id" IN (SELECT "tagId" FROM OLD));
      RETURN NULL;
    END`,
});
