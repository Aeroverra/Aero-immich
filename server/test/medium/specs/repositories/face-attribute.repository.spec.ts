import { Kysely } from 'kysely';
import { AssetFileType, AssetVisibility } from 'src/enum';
import { FaceAttributeRepository } from 'src/repositories/face-attribute.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { DB } from 'src/schema';
import { BaseService } from 'src/services/base.service';
import { newMediumService } from 'test/medium.factory';
import { newUuid } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(FaceAttributeRepository) };
};

const quality = (assetId: string, sharpness = 100) => ({
  assetId,
  sharpness,
  exposureClipped: 0.01,
  brightness: 0.5,
  modelName: 'laplacian',
});

const attributes = (faceId: string, smile: number | null = 0.7) => ({
  faceId,
  eyeBlinkLeft: smile === null ? null : 0.1,
  eyeBlinkRight: smile === null ? null : 0.2,
  smile,
  yaw: smile === null ? null : 5,
  pitch: smile === null ? null : -3,
  roll: smile === null ? null : 1,
  sharpness: 250,
  detected: smile !== null,
  modelName: 'face_landmarker',
});

const newAssetWithFaces = async (ctx: ReturnType<typeof setup>['ctx'], faceCount: number) => {
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: '/preview.jpg' });
  await ctx.newJobStatus({ assetId: asset.id });
  await ctx.database
    .updateTable('asset_job_status')
    .set({ facesRecognizedAt: new Date() })
    .where('assetId', '=', asset.id)
    .execute();
  const faces = [];
  for (let index = 0; index < faceCount; index++) {
    const { assetFace } = await ctx.newAssetFace({
      assetId: asset.id,
      imageWidth: 1440,
      imageHeight: 1080,
      boundingBoxX1: 10 * index,
      boundingBoxY1: 20,
      boundingBoxX2: 10 * index + 100,
      boundingBoxY2: 140,
    });
    faces.push(assetFace);
  }
  return { user, asset, faces };
};

const collect = async (stream: AsyncIterable<{ id: string }>) => {
  const ids: string[] = [];
  for await (const { id } of stream) {
    ids.push(id);
  }
  return ids;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(FaceAttributeRepository.name, () => {
  describe('getForFaceAttributesJob', () => {
    it('should return the preview and the faces that are not deleted', async () => {
      const { ctx, sut } = setup();
      const { asset, faces } = await newAssetWithFaces(ctx, 2);
      await ctx.database
        .updateTable('asset_face')
        .set({ deletedAt: new Date() })
        .where('id', '=', faces[1].id)
        .execute();

      await expect(sut.getForFaceAttributesJob(asset.id)).resolves.toEqual({
        id: asset.id,
        visibility: AssetVisibility.Timeline,
        previewFile: '/preview.jpg',
        faces: [
          {
            id: faces[0].id,
            imageWidth: 1440,
            imageHeight: 1080,
            boundingBoxX1: 0,
            boundingBoxY1: 20,
            boundingBoxX2: 100,
            boundingBoxY2: 140,
          },
        ],
      });
    });
  });

  describe('upsert', () => {
    it('should store and replace the results', async () => {
      const { ctx, sut } = setup();
      const { asset, faces } = await newAssetWithFaces(ctx, 2);

      await sut.upsert(quality(asset.id), [attributes(faces[0].id), attributes(faces[1].id, null)]);
      await expect(sut.getQualityByAssetIds([asset.id])).resolves.toEqual([
        expect.objectContaining({ ...quality(asset.id), updatedAt: expect.any(Date) }),
      ]);

      await sut.upsert(quality(asset.id, 5), [attributes(faces[0].id, 0.1)]);

      await expect(sut.getQualityByAssetIds([asset.id])).resolves.toEqual([
        expect.objectContaining({ assetId: asset.id, sharpness: 5 }),
      ]);
      const stored = await sut.getFaceAttributesByAssetIds([asset.id]);
      expect(stored).toHaveLength(2);
      expect(stored).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ...attributes(faces[0].id, 0.1),
            smile: expect.closeTo(0.1, 5),
            eyeBlinkLeft: expect.closeTo(0.1, 5),
            eyeBlinkRight: expect.closeTo(0.2, 5),
            assetId: asset.id,
            boundingBoxX1: 0,
            isVisible: true,
          }),
          expect.objectContaining({ ...attributes(faces[1].id, null), assetId: asset.id }),
        ]),
      );
    });

    it('should ignore faces that no longer exist', async () => {
      const { ctx, sut } = setup();
      const { asset, faces } = await newAssetWithFaces(ctx, 1);

      await sut.upsert(quality(asset.id), [attributes(faces[0].id), attributes(newUuid())]);

      await expect(sut.getFaceAttributesByAssetIds([asset.id])).resolves.toEqual([
        expect.objectContaining({ faceId: faces[0].id }),
      ]);
    });

    it('should do nothing for an asset that no longer exists', async () => {
      const { sut } = setup();
      const assetId = newUuid();

      await expect(sut.upsert(quality(assetId), [attributes(newUuid())])).resolves.toBeUndefined();

      await expect(sut.getQualityByAssetIds([assetId])).resolves.toEqual([]);
    });
  });

  describe('cascades', () => {
    it('should delete the attributes of a deleted face without touching other faces or people', async () => {
      const { ctx, sut } = setup();
      const { user, asset, faces } = await newAssetWithFaces(ctx, 2);
      const { person } = await ctx.newPerson({ ownerId: user.id });
      await ctx.database
        .updateTable('asset_face')
        .set({ personGroupId: person.personGroupId })
        .where('assetId', '=', asset.id)
        .execute();
      await sut.upsert(quality(asset.id), [attributes(faces[0].id), attributes(faces[1].id)]);

      await ctx.database.deleteFrom('asset_face').where('id', '=', faces[1].id).execute();

      await expect(sut.getFaceAttributesByAssetIds([asset.id])).resolves.toEqual([
        expect.objectContaining({ faceId: faces[0].id }),
      ]);
      const remaining = await ctx.database
        .selectFrom('asset_face')
        .select(['id', 'personGroupId'])
        .where('assetId', '=', asset.id)
        .execute();
      expect(remaining).toEqual([{ id: faces[0].id, personGroupId: person.personGroupId }]);
    });

    it('should delete everything when the asset is deleted', async () => {
      const { ctx, sut } = setup();
      const { asset, faces } = await newAssetWithFaces(ctx, 1);
      await sut.upsert(quality(asset.id), [attributes(faces[0].id)]);

      await ctx.database.deleteFrom('asset').where('id', '=', asset.id).execute();

      await expect(sut.getQualityByAssetIds([asset.id])).resolves.toEqual([]);
      const rows = await ctx.database
        .selectFrom('asset_face_attribute')
        .selectAll()
        .where('faceId', '=', faces[0].id)
        .execute();
      expect(rows).toEqual([]);
    });
  });

  describe('streamForFaceAttributesJob', () => {
    it('should only return assets with missing results unless forced', async () => {
      const { ctx, sut } = setup();
      const done = await newAssetWithFaces(ctx, 1);
      const missingQuality = await newAssetWithFaces(ctx, 0);
      const missingFace = await newAssetWithFaces(ctx, 2);
      await sut.upsert(quality(done.asset.id), [attributes(done.faces[0].id)]);
      await sut.upsert(quality(missingFace.asset.id), [attributes(missingFace.faces[0].id)]);

      const missing = await collect(sut.streamForFaceAttributesJob({ force: false, facesDetected: true }));
      expect(missing).toEqual(expect.arrayContaining([missingQuality.asset.id, missingFace.asset.id]));
      expect(missing).not.toContain(done.asset.id);

      const all = await collect(sut.streamForFaceAttributesJob({ force: true, facesDetected: true }));
      expect(all).toEqual(expect.arrayContaining([done.asset.id, missingQuality.asset.id, missingFace.asset.id]));
    });

    it('should wait for face detection and skip hidden assets and assets without previews', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset: undetected } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAssetFile({ assetId: undetected.id, type: AssetFileType.Preview, path: '/preview.jpg' });
      await ctx.newJobStatus({ assetId: undetected.id });
      await ctx.database
        .updateTable('asset_job_status')
        .set({ facesRecognizedAt: null })
        .where('assetId', '=', undetected.id)
        .execute();
      const { asset: withoutPreview } = await ctx.newAsset({ ownerId: user.id });
      const hidden = await newAssetWithFaces(ctx, 0);
      await ctx.database
        .updateTable('asset')
        .set({ visibility: AssetVisibility.Hidden })
        .where('id', '=', hidden.asset.id)
        .execute();

      const waiting = await collect(sut.streamForFaceAttributesJob({ force: true, facesDetected: true }));
      expect(waiting).not.toContain(undetected.id);
      expect(waiting).not.toContain(withoutPreview.id);
      expect(waiting).not.toContain(hidden.asset.id);

      const notWaiting = await collect(sut.streamForFaceAttributesJob({ force: true, facesDetected: false }));
      expect(notWaiting).toContain(undetected.id);
      expect(notWaiting).not.toContain(withoutPreview.id);
      expect(notWaiting).not.toContain(hidden.asset.id);
    });
  });
});
