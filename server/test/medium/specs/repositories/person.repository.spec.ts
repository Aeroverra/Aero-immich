import { Insertable, Kysely } from 'kysely';
import { AssetFace, ViewFilter } from 'src/database';
import { AssetFileType, AssetType, AssetVisibility, ViewAccess, ViewPrivateAssets } from 'src/enum';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PersonRepository } from 'src/repositories/person.repository';
import { TagRepository } from 'src/repositories/tag.repository';
import { DB } from 'src/schema';
import { AssetTable } from 'src/schema/tables/asset.table';
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
  return { ctx, sut: ctx.get(PersonRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

/** a person with faces of every size on photos, a video frame, and assets the caller may not see */
const setupLibrary = async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { person } = await ctx.newPerson({ ownerId: user.id });
  const nsfw = await ctx.get(TagRepository).create({ userId: user.id, value: 'NSFW' });
  const child = await ctx.get(TagRepository).create({ userId: user.id, value: 'NSFW/Cams', parentId: nsfw.id });

  // a face covering size x size pixels of a 1000 x 1000 picture
  const newFace = async (
    size: number,
    asset: Partial<Insertable<AssetTable>> = {},
    face: Partial<Insertable<AssetFace>> = {},
  ) => {
    const { asset: created } = await ctx.newAsset({ ownerId: user.id, ...asset });
    const { assetFace } = await ctx.newAssetFace({
      assetId: created.id,
      personGroupId: person.personGroupId,
      imageWidth: 1000,
      imageHeight: 1000,
      boundingBoxX1: 0,
      boundingBoxY1: 0,
      boundingBoxX2: size,
      boundingBoxY2: size,
      ...face,
    });
    return { asset: created, face: assetFace };
  };

  const faces = {
    // the biggest face is on an asset tagged with a child of the excluded tag
    tagged: await newFace(900),
    private: await newFace(800, { isPrivate: true }),
    trashed: await newFace(700, { deletedAt: new Date() }),
    hidden: await newFace(650, { visibility: AssetVisibility.Hidden }),
    wholeAsset: await newFace(1000, {}, { isWholeAsset: true }),
    videoFrame: await newFace(600, { type: AssetType.Video }, { frameTimestamp: 1500 }),
    archived: await newFace(300, { visibility: AssetVisibility.Archive }),
    small: await newFace(200),
  };
  await ctx.newTagAsset({ tagIds: [child.id], assetIds: [faces.tagged.asset.id] });

  const view: ViewFilter = {
    id: newUuid(),
    ownerId: user.id,
    access: ViewAccess.Open,
    includeAll: true,
    includeUntagged: false,
    includeTagIds: [],
    excludeTagIds: [nsfw.id],
    privateAssets: ViewPrivateAssets.Unlocked,
  };

  return { sut, user, person, faces, view };
};

describe(PersonRepository.name, () => {
  describe('createAll', () => {
    it('should create people in the groups they were given', async () => {
      const { ctx, sut } = setup();
      const [{ user: user1 }, { user: user2 }] = [await ctx.newUser(), await ctx.newUser()];

      const [group1, group2] = await sut.createGroups([
        { clusterGroupId: user1.clusterGroupId },
        { clusterGroupId: user1.clusterGroupId },
      ]);
      const group3 = await sut.createGroup(user2.id);

      const people = await sut.createAll([
        { ownerId: user1.id, name: 'Alice', personGroupId: group1.id },
        { ownerId: user1.id, name: 'Bob', personGroupId: group2.id },
        { ownerId: user2.id, name: 'Carol', personGroupId: group3.id },
      ]);

      expect(people.map(({ personGroupId }) => personGroupId)).toEqual([group1.id, group2.id, group3.id]);

      const groups = await ctx.database
        .selectFrom('person')
        .innerJoin('person_group', 'person_group.id', 'person.personGroupId')
        .innerJoin('user', 'user.id', 'person.ownerId')
        .select(['person.name', 'person_group.clusterGroupId', 'user.clusterGroupId as ownerClusterGroupId'])
        .where(
          'person.personGroupId',
          'in',
          people.map(({ personGroupId }) => personGroupId),
        )
        .execute();

      expect(groups).toHaveLength(3);
      for (const group of groups) {
        expect(group.clusterGroupId).toBe(group.ownerClusterGroupId);
      }
    });
  });

  describe('createGroup', () => {
    it('should create a group in the owner cluster group', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const group = await sut.createGroup(user.id);

      const owner = await ctx.database
        .selectFrom('person_group')
        .innerJoin('user', 'user.clusterGroupId', 'person_group.clusterGroupId')
        .select('user.id')
        .where('person_group.id', '=', group.id)
        .executeTakeFirstOrThrow();

      expect(owner.id).toBe(user.id);
    });

    it('should put people created with the same group into that group', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const [{ user: user1 }, { user: user2 }] = [await ctx.newUser(), await ctx.newUser()];

      const group = await sut.createGroup(user1.id);
      const person1 = await sut.create({ ownerId: user1.id, name: 'Alice', personGroupId: group.id });
      const person2 = await sut.create({ ownerId: user2.id, name: 'Alice', personGroupId: group.id });

      expect(person1.personGroupId).toBe(group.id);
      expect(person2.personGroupId).toBe(group.id);

      const groups = await ctx.database.selectFrom('person_group').select('person_group.id').execute();
      expect(groups.map(({ id }) => id)).toEqual([group.id]);
    });
  });

  describe('getByGroupId', () => {
    it('should not return a person owned by another user', async () => {
      const { ctx, sut } = setup();
      const [{ user: user1 }, { user: user2 }] = [await ctx.newUser(), await ctx.newUser()];
      const group = await sut.createGroup(user1.id);

      const person1 = await sut.create({ ownerId: user1.id, name: 'Alice', personGroupId: group.id });
      const person2 = await ctx.database
        .insertInto('person')
        .values({ ownerId: user2.id, name: 'Alice', personGroupId: person1.personGroupId })
        .returningAll()
        .executeTakeFirstOrThrow();

      await expect(sut.getByGroupId({ ownerId: user1.id, personGroupId: person1.personGroupId })).resolves.toEqual(
        expect.objectContaining({ personGroupId: person1.personGroupId, ownerId: user1.id }),
      );
      await expect(sut.getByGroupId({ ownerId: user2.id, personGroupId: person1.personGroupId })).resolves.toEqual(
        expect.objectContaining({ personGroupId: person2.personGroupId, ownerId: user2.id }),
      );
    });

    it('should return nothing when the group belongs to another user', async () => {
      const { ctx, sut } = setup();
      const [{ user: user1 }, { user: user2 }] = [await ctx.newUser(), await ctx.newUser()];
      const group = await sut.createGroup(user1.id);

      const person = await sut.create({ ownerId: user1.id, name: 'Alice', personGroupId: group.id });

      await expect(
        sut.getByGroupId({ ownerId: user2.id, personGroupId: person.personGroupId }),
      ).resolves.toBeUndefined();
    });
  });

  describe('deleteEmptyGroups', () => {
    it('should delete groups that no longer have any people', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const [keptGroup, emptiedGroup] = await sut.createGroups([
        { clusterGroupId: user.clusterGroupId },
        { clusterGroupId: user.clusterGroupId },
      ]);

      const kept = await sut.create({ ownerId: user.id, name: 'Alice', personGroupId: keptGroup.id });
      const emptied = await sut.create({ ownerId: user.id, name: 'Bob', personGroupId: emptiedGroup.id });
      await ctx.database
        .deleteFrom('person')
        .where('person.ownerId', '=', emptied.ownerId)
        .where('person.personGroupId', '=', emptied.personGroupId)
        .execute();

      await expect(sut.deleteEmptyGroups()).resolves.toBe(1);

      const groups = await ctx.database.selectFrom('person_group').select('person_group.id').execute();
      expect(groups.map(({ id }) => id)).toEqual([kept.personGroupId]);
    });
  });

  describe('deleteOrphanedClusterGroups', () => {
    it('should delete cluster groups that no longer belong to a user, along with their people', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const [{ user: kept }, { user: removed }] = [await ctx.newUser(), await ctx.newUser()];
      const keptGroup = await sut.createGroup(kept.id);
      const removedGroup = await sut.createGroup(removed.id);

      const keptPerson = await sut.create({ ownerId: kept.id, name: 'Alice', personGroupId: keptGroup.id });
      await sut.create({ ownerId: removed.id, name: 'Bob', personGroupId: removedGroup.id });
      const { clusterGroupId } = await ctx.database
        .selectFrom('user')
        .select('user.clusterGroupId')
        .where('user.id', '=', kept.id)
        .executeTakeFirstOrThrow();
      await ctx.database.deleteFrom('user').where('user.id', '=', removed.id).execute();

      await expect(sut.deleteOrphanedClusterGroups()).resolves.toBe(1);

      const clusterGroups = await ctx.database.selectFrom('cluster_group').select('cluster_group.id').execute();
      expect(clusterGroups.map(({ id }) => id)).toEqual([clusterGroupId]);

      const groups = await ctx.database.selectFrom('person_group').select('person_group.id').execute();
      expect(groups.map(({ id }) => id)).toEqual([keptPerson.personGroupId]);
    });
  });

  describe('getDataForThumbnailGenerationJob', () => {
    it('should not return the edited preview path', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });

      const { assetFace } = await ctx.newAssetFace({
        assetId: asset.id,
        personGroupId: person.personGroupId,
        boundingBoxX1: 10,
        boundingBoxY1: 10,
        boundingBoxX2: 90,
        boundingBoxY2: 90,
      });

      // there's a circular dependency between assetFace and person, so we need to update the person after creating the assetFace
      await ctx.database
        .updateTable('person')
        .set({ faceAssetId: assetFace.id })
        .where('ownerId', '=', person.ownerId)
        .where('personGroupId', '=', person.personGroupId)
        .execute();

      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_edited.jpg',
        isEdited: true,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_unedited.jpg',
        isEdited: false,
      });

      const result = await sut.getDataForThumbnailGenerationJob({
        ownerId: person.ownerId,
        personGroupId: person.personGroupId,
      });

      expect(result).toEqual(
        expect.objectContaining({
          previewPath: 'preview_unedited.jpg',
        }),
      );
    });
  });

  describe('getVisibleFaceForThumbnail', () => {
    it('should prefer a big located face on a photo', async () => {
      const { sut, user, person, faces } = await setupLibrary();

      const face = await sut.getVisibleFaceForThumbnail(
        { ownerId: user.id, personGroupId: person.personGroupId },
        { privateMode: false, userId: user.id },
      );

      expect(face).toEqual(
        expect.objectContaining({ id: faces.tagged.face.id, x2: 900, originalPath: expect.any(String) }),
      );
    });

    it('should skip faces on assets the active view hides', async () => {
      const { sut, user, person, faces, view } = await setupLibrary();

      const face = await sut.getVisibleFaceForThumbnail(
        { ownerId: user.id, personGroupId: person.personGroupId },
        { privateMode: false, userId: user.id, view },
      );

      // private, trashed and hidden assets never count, and a video frame face beats a whole-asset mark only after photos
      expect(face?.id).toBe(faces.archived.face.id);
    });

    it('should use private assets in private mode', async () => {
      const { sut, user, person, faces, view } = await setupLibrary();

      const face = await sut.getVisibleFaceForThumbnail(
        { ownerId: user.id, personGroupId: person.personGroupId },
        { privateMode: true, userId: user.id, view },
      );

      expect(face?.id).toBe(faces.private.face.id);
    });

    it('should only use the given asset', async () => {
      const { sut, user, person, faces, view } = await setupLibrary();
      const id = { ownerId: user.id, personGroupId: person.personGroupId };
      const scope = { privateMode: false, userId: user.id, view };

      await expect(sut.getVisibleFaceForThumbnail(id, scope, faces.small.asset.id)).resolves.toEqual(
        expect.objectContaining({ id: faces.small.face.id }),
      );
      await expect(sut.getVisibleFaceForThumbnail(id, scope, faces.videoFrame.asset.id)).resolves.toEqual(
        expect.objectContaining({ id: faces.videoFrame.face.id, frameTimestamp: 1500 }),
      );
      await expect(sut.getVisibleFaceForThumbnail(id, scope, faces.tagged.asset.id)).resolves.toBeUndefined();
      await expect(sut.getVisibleFaceForThumbnail(id, scope, faces.private.asset.id)).resolves.toBeUndefined();
    });

    it('should fall back to the video frame face and the whole-asset mark last', async () => {
      const { sut, user, person, faces, view } = await setupLibrary();
      const id = { ownerId: user.id, personGroupId: person.personGroupId };
      const scope = { privateMode: false, userId: user.id, view };
      const database = defaultDatabase;
      await database
        .updateTable('asset')
        .set({ deletedAt: new Date() })
        .where('id', 'in', [faces.small.asset.id, faces.archived.asset.id])
        .execute();

      await expect(sut.getVisibleFaceForThumbnail(id, scope)).resolves.toEqual(
        expect.objectContaining({ id: faces.videoFrame.face.id }),
      );

      await database
        .updateTable('asset')
        .set({ deletedAt: new Date() })
        .where('id', '=', faces.videoFrame.asset.id)
        .execute();
      await expect(sut.getVisibleFaceForThumbnail(id, scope)).resolves.toEqual(
        expect.objectContaining({ id: faces.wholeAsset.face.id }),
      );
    });
  });

  describe('getForFeatureFaceUpdate', () => {
    it('should ignore soft deleted faces', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      await ctx.newAssetFace({ assetId: asset.id, deletedAt: new Date(), personGroupId: person.personGroupId });

      await expect(
        sut.getForFeatureFaceUpdate({ personGroupId: person.personGroupId, assetId: asset.id }),
      ).resolves.toEqual(undefined);
    });
  });
});
