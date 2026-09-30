import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetFileType, AssetVisibility } from 'src/enum';
import { DB } from 'src/schema';
import { AssetFaceAttributeTable } from 'src/schema/tables/asset-face-attribute.table';
import { AssetQualityTable } from 'src/schema/tables/asset-quality.table';
import { anyUuid, withFilePath } from 'src/utils/database';

export type FaceAttributeStreamOptions = {
  /** include assets that already have results */
  force?: boolean;
  /** only include assets whose faces have been detected */
  facesDetected?: boolean;
};

@Injectable()
export class FaceAttributeRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  getForFaceAttributesJob(id: string) {
    return this.db
      .selectFrom('asset')
      .select((eb) => [
        'asset.id',
        'asset.visibility',
        withFilePath(eb, AssetFileType.Preview).as('previewFile'),
        jsonArrayFrom(
          eb
            .selectFrom('asset_face')
            .select([
              'asset_face.id',
              'asset_face.imageWidth',
              'asset_face.imageHeight',
              'asset_face.boundingBoxX1',
              'asset_face.boundingBoxY1',
              'asset_face.boundingBoxX2',
              'asset_face.boundingBoxY2',
            ])
            .whereRef('asset_face.assetId', '=', 'asset.id')
            .where('asset_face.deletedAt', 'is', null)
            // faces found in other video frames are not visible in the preview these attributes are measured on
            .where('asset_face.frameTimestamp', 'is', null)
            .orderBy('asset_face.id'),
        ).as('faces'),
      ])
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ force: false, facesDetected: true }], stream: true })
  streamForFaceAttributesJob({ force, facesDetected }: FaceAttributeStreamOptions = {}) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .where('asset.deletedAt', 'is', null)
      .where((eb) =>
        eb.exists((qb) =>
          qb
            .selectFrom('asset_file')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', AssetFileType.Preview),
        ),
      )
      .$if(!!facesDetected, (qb) =>
        qb
          .innerJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
          .where('asset_job_status.facesRecognizedAt', 'is not', null),
      )
      .$if(!force, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb.not(
              eb.exists((qb) => qb.selectFrom('asset_quality').whereRef('asset_quality.assetId', '=', 'asset.id')),
            ),
            eb.exists((qb) =>
              qb
                .selectFrom('asset_face')
                .leftJoin('asset_face_attribute', 'asset_face_attribute.faceId', 'asset_face.id')
                .whereRef('asset_face.assetId', '=', 'asset.id')
                .where('asset_face.deletedAt', 'is', null)
                .where('asset_face.frameTimestamp', 'is', null)
                .where('asset_face_attribute.faceId', 'is', null),
            ),
          ]),
        ),
      )
      .orderBy('asset.fileCreatedAt', 'desc')
      .stream();
  }

  @GenerateSql({
    params: [
      {
        assetId: DummyValue.UUID,
        sharpness: DummyValue.NUMBER,
        exposureClipped: DummyValue.NUMBER,
        brightness: DummyValue.NUMBER,
        modelName: DummyValue.STRING,
      },
      [
        {
          faceId: DummyValue.UUID,
          eyeBlinkLeft: DummyValue.NUMBER,
          eyeBlinkRight: DummyValue.NUMBER,
          smile: DummyValue.NUMBER,
          yaw: DummyValue.NUMBER,
          pitch: DummyValue.NUMBER,
          roll: DummyValue.NUMBER,
          sharpness: DummyValue.NUMBER,
          detected: DummyValue.BOOLEAN,
          modelName: DummyValue.STRING,
        },
      ],
    ],
  })
  async upsert(quality: Insertable<AssetQualityTable>, faces: Insertable<AssetFaceAttributeTable>[]) {
    await this.db.transaction().execute(async (trx) => {
      // the asset and its faces may be deleted while the job runs, the lock keeps them until the rows are written
      const asset = await trx
        .selectFrom('asset')
        .select('asset.id')
        .where('asset.id', '=', quality.assetId)
        .forKeyShare()
        .executeTakeFirst();
      if (!asset) {
        return;
      }

      await trx
        .insertInto('asset_quality')
        .values(quality)
        .onConflict((oc) =>
          oc.column('assetId').doUpdateSet((eb) => ({
            sharpness: eb.ref('excluded.sharpness'),
            exposureClipped: eb.ref('excluded.exposureClipped'),
            brightness: eb.ref('excluded.brightness'),
            modelName: eb.ref('excluded.modelName'),
            updatedAt: sql`now()`,
          })),
        )
        .execute();

      if (faces.length === 0) {
        return;
      }

      const existing = await trx
        .selectFrom('asset_face')
        .select('asset_face.id')
        .where('asset_face.id', '=', anyUuid(faces.map(({ faceId }) => faceId)))
        .forKeyShare()
        .execute();
      const existingIds = new Set(existing.map(({ id }) => id));
      const values = faces.filter(({ faceId }) => existingIds.has(faceId));
      if (values.length === 0) {
        return;
      }

      await trx
        .insertInto('asset_face_attribute')
        .values(values)
        .onConflict((oc) =>
          oc.column('faceId').doUpdateSet((eb) => ({
            eyeBlinkLeft: eb.ref('excluded.eyeBlinkLeft'),
            eyeBlinkRight: eb.ref('excluded.eyeBlinkRight'),
            smile: eb.ref('excluded.smile'),
            yaw: eb.ref('excluded.yaw'),
            pitch: eb.ref('excluded.pitch'),
            roll: eb.ref('excluded.roll'),
            sharpness: eb.ref('excluded.sharpness'),
            detected: eb.ref('excluded.detected'),
            modelName: eb.ref('excluded.modelName'),
            updatedAt: sql`now()`,
          })),
        )
        .execute();
    });
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  getQualityByAssetIds(assetIds: string[]) {
    if (assetIds.length === 0) {
      return Promise.resolve([]);
    }

    return this.db
      .selectFrom('asset_quality')
      .selectAll('asset_quality')
      .where('asset_quality.assetId', '=', anyUuid(assetIds))
      .execute();
  }

  /** The attributes of the faces of the given assets, with the face box they describe. */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  getFaceAttributesByAssetIds(assetIds: string[]) {
    if (assetIds.length === 0) {
      return Promise.resolve([]);
    }

    return this.db
      .selectFrom('asset_face_attribute')
      .innerJoin('asset_face', 'asset_face.id', 'asset_face_attribute.faceId')
      .selectAll('asset_face_attribute')
      .select([
        'asset_face.assetId',
        'asset_face.imageWidth',
        'asset_face.imageHeight',
        'asset_face.boundingBoxX1',
        'asset_face.boundingBoxY1',
        'asset_face.boundingBoxX2',
        'asset_face.boundingBoxY2',
        'asset_face.isVisible',
      ])
      .where('asset_face.assetId', '=', anyUuid(assetIds))
      .where('asset_face.deletedAt', 'is', null)
      .execute();
  }
}
