import { NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { DateTime } from 'luxon';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto';
import { AssetEditAction, MirrorAxis } from 'src/dtos/editing.dto';
import { AssetFaceCreateDto } from 'src/dtos/person.dto';
import { AssetFileType, AssetType, JobName, SourceType } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository';
import { AssetJobRepository } from 'src/repositories/asset-job.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { ConfigRepository } from 'src/repositories/config.repository';
import { CryptoRepository } from 'src/repositories/crypto.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository';
import { PersonRepository } from 'src/repositories/person.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository';
import { DB } from 'src/schema';
import { PersonService } from 'src/services/person.service';
import { newMediumService } from 'test/medium.factory';
import { factory, newEmbedding } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(PersonService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AssetJobRepository,
      ConfigRepository,
      CryptoRepository,
      DatabaseRepository,
      PersonRepository,
      AssetRepository,
      AssetEditRepository,
      SystemMetadataRepository,
    ],
    mock: [JobRepository, LoggingRepository, StorageRepository, MachineLearningRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const newPersonWithFace = async (ctx: ReturnType<typeof setup>['ctx'], ownerId: string, assetId: string) => {
  const { person } = await ctx.newPerson({ ownerId, name: 'Someone' });
  const { assetFace } = await ctx.newAssetFace({ assetId, personGroupId: person.personGroupId });
  return { person, assetFace };
};

describe(PersonService.name, () => {
  describe('delete', () => {
    it('should throw an error when there is no access', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const personId = factory.uuid();
      await expect(sut.delete(auth, personId)).rejects.toThrow('Not found or no person.delete access');
    });

    it('should delete the person', async () => {
      const { sut, ctx } = setup();
      const personRepo = ctx.get(PersonRepository);
      const storageMock = ctx.getMock(StorageRepository);
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const auth = factory.auth({ user });
      storageMock.unlink.mockResolvedValue();

      await expect(personRepo.getByGroupId(person)).resolves.toEqual(
        expect.objectContaining({ personGroupId: person.personGroupId }),
      );
      await expect(sut.delete(auth, person.personGroupId)).resolves.toBeUndefined();
      await expect(personRepo.getByGroupId(person)).resolves.toBeUndefined();

      expect(storageMock.unlink).toHaveBeenCalledWith(person.thumbnailPath);
    });
  });

  describe('deleteAll', () => {
    it('should throw an error when there is no access', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const personId = factory.uuid();
      await expect(sut.deleteAll(auth, { ids: [personId] })).rejects.toThrow('Not found or no person.delete access');
    });

    it('should delete the person', async () => {
      const { sut, ctx } = setup();
      const storageMock = ctx.getMock(StorageRepository);
      const personRepo = ctx.get(PersonRepository);
      const { user } = await ctx.newUser();
      const { person: person1 } = await ctx.newPerson({ ownerId: user.id });
      const { person: person2 } = await ctx.newPerson({ ownerId: user.id });
      const auth = factory.auth({ user });
      storageMock.unlink.mockResolvedValue();

      await expect(
        sut.deleteAll(auth, { ids: [person1.personGroupId, person2.personGroupId] }),
      ).resolves.toBeUndefined();
      await expect(personRepo.getByGroupId(person1)).resolves.toBeUndefined();
      await expect(personRepo.getByGroupId(person2)).resolves.toBeUndefined();

      expect(storageMock.unlink).toHaveBeenCalledTimes(2);
      expect(storageMock.unlink).toHaveBeenCalledWith(person1.thumbnailPath);
      expect(storageMock.unlink).toHaveBeenCalledWith(person2.thumbnailPath);
    });
  });

  describe('handleDetectFaces', () => {
    it('should prefer an edited preview file', async () => {
      const { sut, ctx } = setup();
      const config = await ctx.getConfig();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        isEdited: true,
        path: 'edited_file.jpg',
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        isEdited: false,
        path: 'unedited_file.jpg',
      });
      ctx
        .getMock(MachineLearningRepository)
        .detectFaces.mockResolvedValue({ imageHeight: 42, imageWidth: 69, faces: [] });

      await sut.handleDetectFaces({ id: asset.id });

      expect(ctx.getMock(MachineLearningRepository).detectFaces).toHaveBeenCalledWith(
        'edited_file.jpg',
        config.machineLearning.facialRecognition,
      );
    });

    it('should return a face found on the edited preview where it was found', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, width: 3220, height: 2580 });
      await ctx.newExif({ assetId: asset.id, exifImageWidth: 2580, exifImageHeight: 3220 });
      await ctx.newEdits(asset.id, { edits: [{ action: AssetEditAction.Rotate, parameters: { angle: 270 } }] });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'unedited_file.jpg' });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        isEdited: true,
        path: 'edited_file.jpg',
      });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      ctx.getMock(MachineLearningRepository).detectFaces.mockResolvedValue({
        imageWidth: 1797,
        imageHeight: 1440,
        faces: [{ boundingBox: { x1: 1291, y1: 309, x2: 1416, y2: 485 }, embedding: newEmbedding(), score: 0.9 }],
      });
      const auth = factory.auth({ user });

      await sut.handleDetectFaces({ id: asset.id });

      // shown on the edited image at the same place, scaled to the full size
      await expect(sut.getFacesById(auth, { id: asset.id })).resolves.toEqual([
        expect.objectContaining({
          imageWidth: 3220,
          imageHeight: 2580,
          boundingBoxX1: expect.closeTo(2313, -1),
          boundingBoxY1: expect.closeTo(554, -1),
          boundingBoxX2: expect.closeTo(2537, -1),
          boundingBoxY2: expect.closeTo(869, -1),
        }),
      ]);

      // detecting again on the edited preview keeps the same face
      const [face] = await sut.getFacesById(auth, { id: asset.id });
      await sut.handleDetectFaces({ id: asset.id });
      await expect(sut.getFacesById(auth, { id: asset.id })).resolves.toEqual([
        expect.objectContaining({ id: face.id }),
      ]);
    });
  });

  describe('handleQueueRecognizeFaces', () => {
    it('should delete all people and queue faces for recognition', async () => {
      const { sut, ctx } = setup();
      const jobRepo = ctx.getMock(JobRepository);
      ctx.getMock(StorageRepository).unlink.mockResolvedValue();
      jobRepo.waitForQueueCompletion.mockResolvedValue();
      jobRepo.getJobCounts.mockResolvedValue({ active: 0, waiting: 0, completed: 0, delayed: 0, failed: 0, paused: 0 });
      jobRepo.queueAll.mockResolvedValue();

      const { user } = await ctx.newUser();
      const { user: user1 } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: assetUser1 } = await ctx.newAsset({ ownerId: user1.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { person: personUser1 } = await ctx.newPerson({ ownerId: user1.id });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
      const { assetFace: assetFaceUser1 } = await ctx.newAssetFace({
        assetId: assetUser1.id,
        personGroupId: personUser1.personGroupId,
      });

      await sut.handleQueueRecognizeFaces({ force: true });

      await expect(ctx.database.selectFrom('person').selectAll().execute()).resolves.toHaveLength(0);
      expect(jobRepo.queueAll).toHaveBeenCalledWith(
        expect.objectContaining([
          { name: JobName.FacialRecognition, data: { id: assetFace.id, deferred: false } },
          { name: JobName.FacialRecognition, data: { id: assetFaceUser1.id, deferred: false } },
        ]),
      );
    });

    it('should only delete all people of a specified cluster group and queue their faces for recognition', async () => {
      const { sut, ctx } = setup();
      const jobRepo = ctx.getMock(JobRepository);
      ctx.getMock(StorageRepository).unlink.mockResolvedValue();
      jobRepo.waitForQueueCompletion.mockResolvedValue();
      jobRepo.getJobCounts.mockResolvedValue({ active: 0, waiting: 0, completed: 0, delayed: 0, failed: 0, paused: 0 });
      jobRepo.queueAll.mockResolvedValue();

      const { user } = await ctx.newUser();
      const { user: user1 } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: assetUser1 } = await ctx.newAsset({ ownerId: user1.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { person: personUser1 } = await ctx.newPerson({ ownerId: user1.id });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
      const { assetFace: assetFaceUser1 } = await ctx.newAssetFace({
        assetId: assetUser1.id,
        personGroupId: personUser1.personGroupId,
      });

      await sut.handleQueueRecognizeFaces({ force: true, clusterGroupId: user.clusterGroupId });

      await expect(ctx.database.selectFrom('person').selectAll().execute()).resolves.toHaveLength(1);
      expect(jobRepo.queueAll).toHaveBeenCalledWith(
        expect.objectContaining([{ name: JobName.FacialRecognition, data: { id: assetFace.id, deferred: false } }]),
      );
      expect(jobRepo.queueAll).not.toHaveBeenCalledWith(
        expect.objectContaining([
          { name: JobName.FacialRecognition, data: { id: assetFace.id, deferred: false } },
          { name: JobName.FacialRecognition, data: { id: assetFaceUser1.id, deferred: false } },
        ]),
      );
    });
  });

  describe('mergePeople', () => {
    it('should merge people of multiple users', async () => {
      const { sut, ctx } = setup();
      const storageMock = ctx.getMock(StorageRepository);
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser({ clusterGroupId: user1.clusterGroupId });
      const { person: person1 } = await ctx.newPerson({ ownerId: user1.id, name: undefined });
      const { person: person2 } = await ctx.newPerson({ ownerId: user1.id });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person1.personGroupId,
      });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person2.personGroupId,
        name: undefined,
      });
      const { asset } = await ctx.newAsset({ ownerId: user2.id });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person2.personGroupId });
      storageMock.unlink.mockResolvedValue();

      const auth = factory.auth({ user: user1 });

      await sut.mergePeople(auth, { ids: [person1.personGroupId, person2.personGroupId] });
      const user1People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user1.id }));
      const user2People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user2.id }));
      expect(user1People).toEqual([expect.objectContaining({ personGroupId: person1.personGroupId })]);
      expect(user2People).toEqual([expect.objectContaining({ personGroupId: person1.personGroupId })]);
      await expect(ctx.get(PersonRepository).getFaces(asset.id, { viewingUserId: asset.ownerId })).resolves.toEqual([
        expect.objectContaining({ personGroupId: person1.personGroupId }),
      ]);
    });

    it('should skip people with a different name', async () => {
      const { sut, ctx } = setup();
      const storageMock = ctx.getMock(StorageRepository);
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser({ clusterGroupId: user1.clusterGroupId });
      const { person: person1 } = await ctx.newPerson({ ownerId: user1.id });
      const { person: person2 } = await ctx.newPerson({ ownerId: user1.id });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person1.personGroupId,
        name: 'Person 1',
      });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person2.personGroupId,
        name: 'Person 2',
      });
      storageMock.unlink.mockResolvedValue();

      const auth = factory.auth({ user: user1 });

      await sut.mergePeople(auth, { ids: [person1.personGroupId, person2.personGroupId] });
      const user1People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user1.id }));
      const user2People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user2.id }));
      expect(user1People).toEqual([expect.objectContaining({ personGroupId: person1.personGroupId })]);
      expect(user2People).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ personGroupId: person1.personGroupId }),
          expect.objectContaining({ personGroupId: person2.personGroupId }),
        ]),
      );
    });

    it('should skip people with a different birth date', async () => {
      const { sut, ctx } = setup();
      const storageMock = ctx.getMock(StorageRepository);
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser({ clusterGroupId: user1.clusterGroupId });
      const { person: person1 } = await ctx.newPerson({ ownerId: user1.id });
      const { person: person2 } = await ctx.newPerson({ ownerId: user1.id });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person1.personGroupId,
        birthDate: DateTime.now().minus({ years: 1 }).toJSDate(),
      });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person2.personGroupId,
        birthDate: DateTime.now().minus({ years: 2 }).toJSDate(),
      });
      storageMock.unlink.mockResolvedValue();

      const auth = factory.auth({ user: user1 });

      await sut.mergePeople(auth, { ids: [person1.personGroupId, person2.personGroupId] });
      const user1People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user1.id }));
      const user2People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user2.id }));
      expect(user1People).toEqual([expect.objectContaining({ personGroupId: person1.personGroupId })]);
      expect(user2People).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ personGroupId: person1.personGroupId }),
          expect.objectContaining({ personGroupId: person2.personGroupId }),
        ]),
      );
    });

    it('should not merge into person another user does not have', async () => {
      const { sut, ctx } = setup();
      const storageMock = ctx.getMock(StorageRepository);
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser({ clusterGroupId: user1.clusterGroupId });
      const { person: person1 } = await ctx.newPerson({ ownerId: user1.id });
      const { person: person2 } = await ctx.newPerson({ ownerId: user1.id });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person2.personGroupId,
      });
      const { asset } = await ctx.newAsset({ ownerId: user2.id });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person2.personGroupId });
      storageMock.unlink.mockResolvedValue();

      const auth = factory.auth({ user: user1 });

      await sut.mergePeople(auth, { ids: [person1.personGroupId, person2.personGroupId] });
      const user1People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user1.id }));
      const user2People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user2.id }));
      expect(user1People).toEqual([expect.objectContaining({ personGroupId: person1.personGroupId })]);
      expect(user2People).toEqual([expect.objectContaining({ personGroupId: person2.personGroupId })]);
      await expect(ctx.get(PersonRepository).getFaces(asset.id, { viewingUserId: asset.ownerId })).resolves.toEqual([
        expect.objectContaining({ personGroupId: person2.personGroupId }),
      ]);
    });
  });

  describe('createFace', () => {
    it('should store and retrieve the face as-is when there are no edits', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 200, height: 200 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 200,
        imageHeight: 200,
        x: 50,
        y: 50,
        width: 150,
        height: 150,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      // retrieve an asset's faces
      const faces = sut.getFacesById(auth, { id: asset.id });

      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 50,
            boundingBoxX2: 200,
            boundingBoxY2: 200,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Crop)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 150, height: 200 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 50,
              y: 50,
              width: 150,
              height: 200,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 150,
        imageHeight: 200,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      // retrieve an asset's faces
      const faces = sut.getFacesById(auth, { id: asset.id });

      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 0,
            boundingBoxY1: 0,
            boundingBoxX2: 100,
            boundingBoxY2: 100,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });

      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toHaveLength(1);
      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 50,
            boundingBoxX2: 150,
            boundingBoxY2: 150,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Rotate 90)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 100, height: 200 });
      await ctx.newExif({ assetId: asset.id, exifImageWidth: 200, exifImageHeight: 100 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 90,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 100,
        imageHeight: 200,
        x: 25,
        y: 50,
        width: 10,
        height: 10,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: expect.closeTo(25, 1),
            boundingBoxY1: expect.closeTo(50, 1),
            boundingBoxX2: expect.closeTo(35, 1),
            boundingBoxY2: expect.closeTo(60, 1),
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 65,
            boundingBoxX2: 60,
            boundingBoxY2: 75,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Mirror Horizontal)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 200, height: 100 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 100, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 200,
        imageHeight: 100,
        x: 50,
        y: 25,
        width: 100,
        height: 50,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 25,
            boundingBoxX2: 150,
            boundingBoxY2: 75,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 25,
            boundingBoxX2: 150,
            boundingBoxY2: 75,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Crop + Rotate)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 200, height: 150 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 50,
              y: 0,
              width: 150,
              height: 200,
            },
          },
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 90,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 200,
        imageHeight: 150,
        x: 50,
        y: 25,
        width: 10,
        height: 20,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: expect.closeTo(50, 1),
            boundingBoxY1: expect.closeTo(25, 1),
            boundingBoxX2: expect.closeTo(60, 1),
            boundingBoxY2: expect.closeTo(45, 1),
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 75,
            boundingBoxY1: 140,
            boundingBoxX2: 95,
            boundingBoxY2: 150,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Crop + Mirror)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 150, height: 100 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 100, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 50,
              y: 0,
              width: 150,
              height: 100,
            },
          },
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 150,
        imageHeight: 100,
        x: 25,
        y: 25,
        width: 75,
        height: 50,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 25,
            boundingBoxY1: 25,
            boundingBoxX2: 100,
            boundingBoxY2: 75,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 100,
            boundingBoxY1: 25,
            boundingBoxX2: 175,
            boundingBoxY2: 75,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Rotate + Mirror)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 200, height: 150 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 150 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 90,
            },
          },
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 200,
        imageHeight: 150,
        x: 50,
        y: 25,
        width: 15,
        height: 20,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: expect.closeTo(50, 1),
            boundingBoxY1: expect.closeTo(25, 1),
            boundingBoxX2: expect.closeTo(65, 1),
            boundingBoxY2: expect.closeTo(45, 1),
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 25,
            boundingBoxY1: 50,
            boundingBoxX2: 45,
            boundingBoxY2: 65,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Crop + Rotate + Mirror)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 150, height: 100 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 50,
              y: 25,
              width: 100,
              height: 150,
            },
          },
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 270,
            },
          },
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 150,
        imageHeight: 150,
        x: 25,
        y: 50,
        width: 75,
        height: 50,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 25,
            boundingBoxY1: 49,
            boundingBoxX2: 99,
            boundingBoxY2: 100,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 75,
            boundingBoxX2: 100,
            boundingBoxY2: 150,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates with multiple mirrors in sequence', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 100, height: 100 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 100, exifImageWidth: 100 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Vertical,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 100,
        imageHeight: 100,
        x: 10,
        y: 10,
        width: 80,
        height: 80,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 10,
            boundingBoxY1: 10,
            boundingBoxX2: 90,
            boundingBoxY2: 90,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 10,
            boundingBoxY1: 10,
            boundingBoxX2: 90,
            boundingBoxY2: 90,
          }),
        ]),
      );
    });

    it('should properly handle exif orientation when creating a face on an edited asset', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 100, height: 100 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 100, orientation: '6' });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Vertical,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 100,
        imageHeight: 100,
        x: 10,
        y: 10,
        width: 80,
        height: 80,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 110,
            boundingBoxY1: 10,
            boundingBoxX2: 190,
            boundingBoxY2: 90,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 10,
            boundingBoxY1: 10,
            boundingBoxX2: 90,
            boundingBoxY2: 90,
          }),
        ]),
      );
    });
  });

  describe('createFace in a video frame', () => {
    it('should store a located face at a moment of the video', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Someone' });
      const { asset: video } = await ctx.newAsset({
        ownerId: user.id,
        type: AssetType.Video,
        width: 1920,
        height: 1080,
        duration: 30_000,
      });
      await ctx.newExif({ assetId: video.id, exifImageWidth: 1920, exifImageHeight: 1080 });

      await sut.createFace(auth, {
        assetId: video.id,
        personId: person.personGroupId,
        imageWidth: 1280,
        imageHeight: 720,
        x: 600,
        y: 100,
        width: 80,
        height: 90,
        frameTimestamp: 12_345,
      });

      const [face] = await sut.getFacesById(auth, { id: video.id });
      expect(face).toEqual(
        expect.objectContaining({
          person: expect.objectContaining({ id: person.personGroupId }),
          imageWidth: 1280,
          imageHeight: 720,
          boundingBoxX1: 600,
          boundingBoxY1: 100,
          boundingBoxX2: 680,
          boundingBoxY2: 190,
          sourceType: SourceType.Manual,
          frameTimestamp: 12_345,
          isWholeAsset: false,
        }),
      );
      await expect(
        ctx.get(PersonRepository).getByGroupId({ ownerId: user.id, personGroupId: person.personGroupId }),
      ).resolves.toMatchObject({ faceAssetId: face.id });

      // a located face, not a whole-asset mark: adding the person again is a duplicate and removal keeps it
      await expect(sut.addToAssets(auth, person.personGroupId, { ids: [video.id] })).resolves.toEqual([
        { id: video.id, success: false, error: BulkIdErrorReason.DUPLICATE },
      ]);
      await expect(sut.removeFromAssets(auth, person.personGroupId, { ids: [video.id] })).resolves.toEqual([
        { id: video.id, success: false, error: BulkIdErrorReason.VALIDATION },
      ]);
      await expect(sut.getFacesById(auth, { id: video.id })).resolves.toEqual([
        expect.objectContaining({ id: face.id, frameTimestamp: 12_345 }),
      ]);
    });

    it('should prefer a frame face over a whole-video mark as the feature photo', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Someone' });
      const { asset: marked } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      await ctx.newExif({ assetId: marked.id, exifImageWidth: 640, exifImageHeight: 480 });
      const { asset: video } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, duration: 10_000 });
      await ctx.newExif({ assetId: video.id, exifImageWidth: 640, exifImageHeight: 480 });
      await sut.addToAssets(auth, person.personGroupId, { ids: [marked.id] });

      await sut.createFace(auth, {
        assetId: video.id,
        personId: person.personGroupId,
        imageWidth: 640,
        imageHeight: 480,
        x: 10,
        y: 10,
        width: 50,
        height: 50,
        frameTimestamp: 4000,
      });
      await sut.createNewFeaturePhoto([{ ownerId: user.id, personGroupId: person.personGroupId }]);

      const [frameFace] = await sut.getFacesById(auth, { id: video.id });
      await expect(
        ctx.get(PersonRepository).getByGroupId({ ownerId: user.id, personGroupId: person.personGroupId }),
      ).resolves.toMatchObject({ faceAssetId: frameFace.id });
    });

    it('should store a given embedding for facial recognition', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Someone' });
      const { asset: video } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, duration: 10_000 });
      await ctx.newExif({ assetId: video.id, exifImageWidth: 640, exifImageHeight: 480 });
      const embedding = Array.from({ length: 512 }, (_, index) => Math.sin(index + 1));

      await sut.createFace(auth, {
        assetId: video.id,
        personId: person.personGroupId,
        imageWidth: 640,
        imageHeight: 480,
        x: 10,
        y: 10,
        width: 50,
        height: 50,
        frameTimestamp: 4000,
        embedding,
      });

      const [face] = await sut.getFacesById(auth, { id: video.id });
      expect(face).toMatchObject({ frameTimestamp: 4000, sourceType: SourceType.Manual, isWholeAsset: false });
      const { rows } = await sql<{ distance: number }>`
        select "embedding" <=> ${JSON.stringify(embedding)}::vector as "distance"
        from "face_search" where "faceId" = ${face.id}
      `.execute(ctx.database);
      expect(rows).toHaveLength(1);
      expect(rows[0].distance).toBeCloseTo(0, 5);
    });

    it('should refuse a frame timestamp on a photo or past the end of the video', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Someone' });
      const { asset: photo } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
      await ctx.newExif({ assetId: photo.id, exifImageWidth: 640, exifImageHeight: 480 });
      const { asset: video } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, duration: 10_000 });
      await ctx.newExif({ assetId: video.id, exifImageWidth: 640, exifImageHeight: 480 });
      const box = { imageWidth: 640, imageHeight: 480, x: 10, y: 10, width: 50, height: 50 };

      await expect(
        sut.createFace(auth, { assetId: photo.id, personId: person.personGroupId, ...box, frameTimestamp: 0 }),
      ).rejects.toThrow('A frame timestamp can only be set for a video');
      await expect(
        sut.createFace(auth, { assetId: video.id, personId: person.personGroupId, ...box, frameTimestamp: 10_001 }),
      ).rejects.toThrow('Frame timestamp is past the end of the video');
      await expect(sut.getFacesById(auth, { id: photo.id })).resolves.toEqual([]);
      await expect(sut.getFacesById(auth, { id: video.id })).resolves.toEqual([]);
    });
  });

  describe('addToAssets', () => {
    it('should mark videos and photos with a whole-asset face', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Someone' });
      const { asset: video } = await ctx.newAsset({
        ownerId: user.id,
        type: AssetType.Video,
        width: 1920,
        height: 1080,
      });
      await ctx.newExif({ assetId: video.id, exifImageWidth: 1920, exifImageHeight: 1080 });
      const { asset: photo } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image, width: 400, height: 300 });
      await ctx.newExif({ assetId: photo.id, exifImageWidth: 4000, exifImageHeight: 3000 });
      const auth = factory.auth({ user });

      await expect(sut.addToAssets(auth, person.personGroupId, { ids: [video.id, photo.id] })).resolves.toEqual([
        { id: video.id, success: true },
        { id: photo.id, success: true },
      ]);

      await expect(sut.getFacesById(auth, { id: video.id })).resolves.toEqual([
        expect.objectContaining({
          person: expect.objectContaining({ id: person.personGroupId }),
          imageWidth: 1920,
          imageHeight: 1080,
          boundingBoxX1: 0,
          boundingBoxY1: 0,
          boundingBoxX2: 1920,
          boundingBoxY2: 1080,
          sourceType: SourceType.Manual,
          isWholeAsset: true,
        }),
      ]);
      await expect(sut.getFacesById(auth, { id: photo.id })).resolves.toEqual([
        expect.objectContaining({ boundingBoxX2: 4000, boundingBoxY2: 3000, isWholeAsset: true }),
      ]);
      await expect(sut.getStatistics(auth, person.personGroupId)).resolves.toEqual({ assets: 2 });
      await expect(
        ctx.get(PersonRepository).getByGroupId({ ownerId: user.id, personGroupId: person.personGroupId }),
      ).resolves.toMatchObject({ faceAssetId: expect.any(String) });

      await expect(sut.addToAssets(auth, person.personGroupId, { ids: [video.id] })).resolves.toEqual([
        { id: video.id, success: false, error: BulkIdErrorReason.DUPLICATE },
      ]);
      await expect(sut.getFacesById(auth, { id: video.id })).resolves.toHaveLength(1);
    });

    it('should not mark an asset the person is already detected on', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: photo } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
      await ctx.newExif({ assetId: photo.id, exifImageWidth: 640, exifImageHeight: 480 });
      const { person } = await newPersonWithFace(ctx, user.id, photo.id);

      await expect(sut.addToAssets(factory.auth({ user }), person.personGroupId, { ids: [photo.id] })).resolves.toEqual(
        [{ id: photo.id, success: false, error: BulkIdErrorReason.DUPLICATE }],
      );
    });

    it('should refuse assets of other users and private assets outside private mode', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Someone' });
      const { asset: foreign } = await ctx.newAsset({ ownerId: other.id, type: AssetType.Video });
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image, isPrivate: true });
      await ctx.newExif({ assetId: hidden.id, exifImageWidth: 640, exifImageHeight: 480 });

      await expect(
        sut.addToAssets(factory.auth({ user }), person.personGroupId, { ids: [foreign.id, hidden.id] }),
      ).resolves.toEqual([
        { id: foreign.id, success: false, error: BulkIdErrorReason.NO_PERMISSION },
        { id: hidden.id, success: false, error: BulkIdErrorReason.NO_PERMISSION },
      ]);

      await expect(
        sut.addToAssets(factory.auth({ user, session: { privateMode: true } }), person.personGroupId, {
          ids: [hidden.id],
        }),
      ).resolves.toEqual([{ id: hidden.id, success: true }]);
    });

    it('should refuse a person of another user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: other.id, name: 'Someone' });
      const { asset: video } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      await ctx.newExif({ assetId: video.id, exifImageWidth: 640, exifImageHeight: 480 });

      await expect(sut.addToAssets(factory.auth({ user }), person.personGroupId, { ids: [video.id] })).rejects.toThrow(
        'Not found or no person.update access',
      );
    });
  });

  describe('removeFromAssets', () => {
    it('should remove marks and keep located faces', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: marked } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
      await ctx.newExif({ assetId: marked.id, exifImageWidth: 640, exifImageHeight: 480 });
      const { asset: detected } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
      await ctx.newExif({ assetId: detected.id, exifImageWidth: 640, exifImageHeight: 480 });
      const { asset: without } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
      await ctx.newExif({ assetId: without.id, exifImageWidth: 640, exifImageHeight: 480 });
      const { person, assetFace } = await newPersonWithFace(ctx, user.id, detected.id);
      await sut.addToAssets(auth, person.personGroupId, { ids: [marked.id] });

      await expect(
        sut.removeFromAssets(auth, person.personGroupId, { ids: [marked.id, detected.id, without.id] }),
      ).resolves.toEqual([
        { id: marked.id, success: true },
        { id: detected.id, success: false, error: BulkIdErrorReason.VALIDATION },
        { id: without.id, success: false, error: BulkIdErrorReason.NOT_FOUND },
      ]);

      await expect(sut.getFacesById(auth, { id: marked.id })).resolves.toEqual([]);
      await expect(sut.getFacesById(auth, { id: detected.id })).resolves.toEqual([
        expect.objectContaining({ id: assetFace.id, isWholeAsset: false }),
      ]);
    });
  });

  describe('getAssetCounts', () => {
    it('should count people and the assets a removal would take them off', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: first } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
      await ctx.newExif({ assetId: first.id, exifImageWidth: 640, exifImageHeight: 480 });
      const { asset: second } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      await ctx.newExif({ assetId: second.id, exifImageWidth: 640, exifImageHeight: 480 });
      const { asset: third } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
      await ctx.newExif({ assetId: third.id, exifImageWidth: 640, exifImageHeight: 480 });
      const { person: detected } = await newPersonWithFace(ctx, user.id, first.id);
      const { person: marked } = await ctx.newPerson({ ownerId: user.id, name: 'Marked' });
      await sut.addToAssets(auth, detected.personGroupId, { ids: [second.id] });
      await sut.addToAssets(auth, marked.personGroupId, { ids: [first.id, second.id] });

      const counts = await sut.getAssetCounts(auth, { assetIds: [first.id, second.id, third.id] });
      expect(counts).toHaveLength(2);
      expect(counts).toEqual(
        expect.arrayContaining([
          { personId: detected.personGroupId, count: 2, removableCount: 1 },
          { personId: marked.personGroupId, count: 2, removableCount: 2 },
        ]),
      );
    });
  });

  describe('whole-asset marks', () => {
    it('should prefer a located face as the feature photo', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: marked } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      await ctx.newExif({ assetId: marked.id, exifImageWidth: 640, exifImageHeight: 480 });
      const { asset: photo } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
      await ctx.newExif({ assetId: photo.id, exifImageWidth: 640, exifImageHeight: 480 });
      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Someone' });
      await sut.addToAssets(auth, person.personGroupId, { ids: [marked.id] });
      const { assetFace } = await ctx.newAssetFace({ assetId: photo.id, personGroupId: person.personGroupId });

      await sut.createNewFeaturePhoto([{ ownerId: user.id, personGroupId: person.personGroupId }]);

      await expect(
        ctx.get(PersonRepository).getByGroupId({ ownerId: user.id, personGroupId: person.personGroupId }),
      ).resolves.toMatchObject({ faceAssetId: assetFace.id });
    });

    it('should delete the marks of a deleted person instead of leaving them without a person', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      ctx.getMock(StorageRepository).unlink.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: marked } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      await ctx.newExif({ assetId: marked.id, exifImageWidth: 640, exifImageHeight: 480 });
      const { asset: detected } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
      await ctx.newExif({ assetId: detected.id, exifImageWidth: 640, exifImageHeight: 480 });
      const { person, assetFace } = await newPersonWithFace(ctx, user.id, detected.id);
      await sut.addToAssets(auth, person.personGroupId, { ids: [marked.id] });

      await sut.delete(auth, person.personGroupId);

      await expect(sut.getFacesById(auth, { id: marked.id })).resolves.toEqual([]);
      await expect(sut.getFacesById(auth, { id: detected.id })).resolves.toEqual([
        expect.objectContaining({ id: assetFace.id, person: null }),
      ]);
    });

    it('should keep one mark per asset when people are merged', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      ctx.getMock(StorageRepository).unlink.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: video } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      await ctx.newExif({ assetId: video.id, exifImageWidth: 640, exifImageHeight: 480 });
      const { person: target } = await ctx.newPerson({ ownerId: user.id, name: 'Target' });
      const { person: source } = await ctx.newPerson({ ownerId: user.id });
      await sut.addToAssets(auth, target.personGroupId, { ids: [video.id] });
      await sut.addToAssets(auth, source.personGroupId, { ids: [video.id] });

      await sut.mergePeople(auth, { ids: [target.personGroupId, source.personGroupId] });

      await expect(sut.getFacesById(auth, { id: video.id })).resolves.toEqual([
        expect.objectContaining({ person: expect.objectContaining({ id: target.personGroupId }), isWholeAsset: true }),
      ]);
    });
  });

  describe('private mode', () => {
    it('should hide people whose faces are only on private assets outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { person: visible } = await newPersonWithFace(ctx, user.id, plain.id);
      const { person: secret } = await newPersonWithFace(ctx, user.id, hidden.id);

      const off = await sut.getAll(factory.auth({ user }), { withHidden: false, page: 1, size: 10 });
      expect(off.total).toBe(1);
      expect(off.people.map(({ id }) => id)).toEqual([visible.personGroupId]);

      const on = await sut.getAll(factory.auth({ user, session: { privateMode: true } }), {
        withHidden: false,
        page: 1,
        size: 10,
      });
      expect(on.total).toBe(2);
      expect(on.people.map(({ id }) => id).sort()).toEqual([visible.personGroupId, secret.personGroupId].sort());
    });

    it('should only count visible assets in the person statistics', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { person } = await newPersonWithFace(ctx, user.id, plain.id);
      await ctx.newAssetFace({ assetId: hidden.id, personGroupId: person.personGroupId });

      await expect(sut.getStatistics(factory.auth({ user }), person.personGroupId)).resolves.toEqual({ assets: 1 });
      await expect(
        sut.getStatistics(factory.auth({ user, session: { privateMode: true } }), person.personGroupId),
      ).resolves.toEqual({ assets: 2 });
    });

    it('should treat a private feature photo as a missing thumbnail outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { person } = await ctx.newPerson({
        ownerId: user.id,
        name: 'Someone',
        thumbnailPath: '/data/thumbs/person.jpeg',
      });
      const { assetFace } = await ctx.newAssetFace({ assetId: hidden.id, personGroupId: person.personGroupId });
      await ctx
        .get(PersonRepository)
        .update({ ownerId: user.id, personGroupId: person.personGroupId, faceAssetId: assetFace.id });

      await expect(sut.getThumbnail(factory.auth({ user }), person.personGroupId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        sut.getThumbnail(factory.auth({ user, session: { privateMode: true } }), person.personGroupId),
      ).resolves.toMatchObject({ path: '/data/thumbs/person.jpeg' });
    });

    it('should prefer a non-private face when choosing a new feature photo', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Someone' });
      await ctx.newAssetFace({ assetId: hidden.id, personGroupId: person.personGroupId });
      const { assetFace: plainFace } = await ctx.newAssetFace({
        assetId: plain.id,
        personGroupId: person.personGroupId,
      });

      await sut.createNewFeaturePhoto([{ ownerId: user.id, personGroupId: person.personGroupId }]);

      await expect(
        ctx.get(PersonRepository).getByGroupId({ ownerId: user.id, personGroupId: person.personGroupId }),
      ).resolves.toMatchObject({ faceAssetId: plainFace.id });
    });
  });
});
