import { Kysely } from 'kysely';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto';
import { JobStatus } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { CustomViewRepository } from 'src/repositories/custom-view.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { TagRepository } from 'src/repositories/tag.repository';
import { DB } from 'src/schema';
import { TagService } from 'src/services/tag.service';
import { upsertTags } from 'src/utils/tag';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(TagService, {
    database: db || defaultDatabase,
    real: [AssetRepository, TagRepository, AccessRepository, CustomViewRepository],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
};

/** A tag owned by one user, plus another user's auth to attempt access with */
const newTagOfAnotherUser = async (ctx: ReturnType<typeof setup>['ctx']) => {
  const { user } = await ctx.newUser();
  const { user: otherUser } = await ctx.newUser();
  const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['tag-1'] });

  return { tag, auth: factory.auth({ user }), otherAuth: factory.auth({ user: otherUser }) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

/** Family, Family/Kids and Friends, one asset tagged Family/Kids */
const newTree = async () => {
  const { sut, ctx } = setup();
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  const { user } = await ctx.newUser();
  const auth = factory.auth({ user });
  const tags = ctx.get(TagRepository);
  const [family, kids, friends] = await upsertTags(tags, {
    userId: user.id,
    tags: ['Family', 'Family/Kids', 'Friends'],
  });
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  await sut.addAssets(auth, kids.id, { ids: [asset.id] });
  return { sut, ctx, auth, user, family, kids, friends, asset };
};

const ancestorsOf = async (ctx: ReturnType<typeof setup>['ctx'], tagId: string) => {
  const rows = await ctx.database
    .selectFrom('tag_closure')
    .innerJoin('tag', 'tag.id', 'tag_closure.id_ancestor')
    .select('tag.value')
    .where('tag_closure.id_descendant', '=', tagId)
    .execute();
  return rows.map(({ value }) => value).toSorted();
};

const exifTags = async (ctx: ReturnType<typeof setup>['ctx'], assetId: string) => {
  const { tags } = await ctx.database
    .selectFrom('asset_exif')
    .select('tags')
    .where('assetId', '=', assetId)
    .executeTakeFirstOrThrow();
  return tags;
};

describe(TagService.name, () => {
  describe('get', () => {
    it('should not return a tag of another user', async () => {
      const { sut, ctx } = setup();
      const { tag, otherAuth } = await newTagOfAnotherUser(ctx);

      await expect(sut.get(otherAuth, tag.id)).rejects.toThrow('Not found or no tag.read access');
    });
  });

  describe('getAssetCounts', () => {
    it('should count how many of the assets carry each tag', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: first } = await ctx.newAsset({ ownerId: user.id });
      const { asset: second } = await ctx.newAsset({ ownerId: user.id });
      const { asset: outside } = await ctx.newAsset({ ownerId: user.id });
      const { tag: both } = await ctx.newTag({ userId: user.id, value: 'Both' });
      const { tag: one } = await ctx.newTag({ userId: user.id, value: 'One' });
      const { tag: elsewhere } = await ctx.newTag({ userId: user.id, value: 'Elsewhere' });
      await ctx.newTagAsset({ tagIds: [both.id], assetIds: [first.id, second.id] });
      await ctx.newTagAsset({ tagIds: [one.id], assetIds: [first.id] });
      await ctx.newTagAsset({ tagIds: [elsewhere.id], assetIds: [outside.id] });

      const counts = await sut.getAssetCounts(auth, { assetIds: [first.id, second.id] });

      expect(counts.toSorted((a, b) => a.tagId.localeCompare(b.tagId))).toEqual(
        [
          { tagId: both.id, count: 2 },
          { tagId: one.id, count: 1 },
        ].toSorted((a, b) => a.tagId.localeCompare(b.tagId)),
      );
    });

    it('should leave out hidden tags while private mode is locked', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { tag: secret } = await ctx.newTag({ userId: user.id, value: 'Secret', isHidden: true });
      await ctx.newTagAsset({ tagIds: [secret.id], assetIds: [asset.id] });

      expect(await sut.getAssetCounts(auth, { assetIds: [asset.id] })).toEqual([]);
    });

    it('should refuse assets the user cannot read', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: other.id });

      await expect(sut.getAssetCounts(factory.auth({ user }), { assetIds: [asset.id] })).rejects.toThrow();
    });
  });

  describe('update', () => {
    it('should not update a tag of another user', async () => {
      const { sut, ctx } = setup();
      const { tag, otherAuth } = await newTagOfAnotherUser(ctx);

      await expect(sut.update(otherAuth, tag.id, { color: '#000000' })).rejects.toThrow(
        'Not found or no tag.update access',
      );
    });

    it('should move a tag with its children under another tag', async () => {
      const { sut, ctx, auth, family, kids, friends, asset } = await newTree();

      await expect(sut.update(auth, family.id, { parentId: friends.id })).resolves.toEqual(
        expect.objectContaining({ id: family.id, value: 'Friends/Family', parentId: friends.id }),
      );

      await expect(sut.get(auth, kids.id)).resolves.toEqual(expect.objectContaining({ value: 'Friends/Family/Kids' }));
      expect(await ancestorsOf(ctx, kids.id)).toEqual(['Friends', 'Friends/Family', 'Friends/Family/Kids']);
      expect(await exifTags(ctx, asset.id)).toEqual(['Friends/Family/Kids']);
      expect(ctx.getMock(JobRepository).queueAll).toHaveBeenCalledWith([
        { name: 'SidecarWrite', data: { id: asset.id } },
      ]);
    });

    it('should rename and move in one update, and move back to the top level', async () => {
      const { sut, ctx, auth, family, kids, asset } = await newTree();

      await expect(sut.update(auth, kids.id, { name: 'Children', parentId: null })).resolves.toEqual(
        expect.objectContaining({ value: 'Children' }),
      );
      expect(await ancestorsOf(ctx, kids.id)).toEqual(['Children']);
      expect(await exifTags(ctx, asset.id)).toEqual(['Children']);

      await sut.update(auth, kids.id, { parentId: family.id });
      expect(await ancestorsOf(ctx, kids.id)).toEqual(['Family', 'Family/Children']);
      expect(await exifTags(ctx, asset.id)).toEqual(['Family/Children']);
    });

    it('should not move a tag under itself or one of its children', async () => {
      const { sut, auth, family, kids } = await newTree();

      await expect(sut.update(auth, family.id, { parentId: family.id })).rejects.toThrow(
        'A tag cannot move under itself or one of its children',
      );
      await expect(sut.update(auth, family.id, { parentId: kids.id })).rejects.toThrow(
        'A tag cannot move under itself or one of its children',
      );
    });

    it('should not move or rename a tag onto an existing path', async () => {
      const { sut, ctx, auth, user, kids, friends } = await newTree();
      await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['Friends/Kids'] });

      await expect(sut.update(auth, kids.id, { parentId: friends.id })).rejects.toThrow(
        'A tag with that name already exists',
      );
      await expect(sut.update(auth, friends.id, { name: 'Family' })).rejects.toThrow(
        'A tag with that name already exists',
      );
    });

    it('should keep the stored tag values of assets in step with a rename', async () => {
      const { sut, ctx, auth, family, asset } = await newTree();

      await sut.update(auth, family.id, { name: 'Relatives' });

      expect(await exifTags(ctx, asset.id)).toEqual(['Relatives/Kids']);
    });
  });

  describe('remove', () => {
    it('should not remove a tag of another user', async () => {
      const { sut, ctx } = setup();
      const { tag, auth, otherAuth } = await newTagOfAnotherUser(ctx);

      await expect(sut.remove(otherAuth, tag.id)).rejects.toThrow('Not found or no tag.delete access');
      await expect(sut.get(auth, tag.id)).resolves.toEqual(expect.objectContaining({ id: tag.id }));
    });
  });

  describe('addAssets', () => {
    it('should not add assets to a tag of another user', async () => {
      const { sut, ctx } = setup();
      const { tag, otherAuth } = await newTagOfAnotherUser(ctx);
      const { asset } = await ctx.newAsset({ ownerId: otherAuth.user.id });

      await expect(sut.addAssets(otherAuth, tag.id, { ids: [asset.id] })).rejects.toThrow(
        'Not found or no tag.asset access',
      );
    });

    it('should lock exif column', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['tag-1'] });
      const authDto = factory.auth({ user });

      await sut.addAssets(authDto, tag.id, { ids: [asset.id] });
      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select(['lockedProperties', 'tags'])
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        lockedProperties: ['tags'],
        tags: ['tag-1'],
      });
      await expect(ctx.get(TagRepository).getByValue(user.id, 'tag-1')).resolves.toEqual(
        expect.objectContaining({ id: tag.id }),
      );
      await expect(ctx.get(TagRepository).getAssetIds(tag.id, [asset.id])).resolves.toContain(asset.id);
    });

    it('should not tag a partner asset', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { user: owner } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: owner.id, inTimeline: true });
      const { asset } = await ctx.newAsset({ ownerId: partner.id });
      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: owner.id, tags: ['tag-1'] });
      const authDto = factory.auth({ user: owner });

      await expect(sut.addAssets(authDto, tag.id, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: false, error: BulkIdErrorReason.NO_PERMISSION },
      ]);
    });
  });

  describe('removeAssets', () => {
    it('should not remove assets from a tag of another user', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { tag, auth, otherAuth } = await newTagOfAnotherUser(ctx);
      const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
      await sut.addAssets(auth, tag.id, { ids: [asset.id] });

      await expect(sut.removeAssets(otherAuth, tag.id, { ids: [asset.id] })).rejects.toThrow(
        'Not found or no tag.asset access',
      );
      await expect(ctx.get(TagRepository).getAssetIds(tag.id, [asset.id])).resolves.toContain(asset.id);
    });
  });

  describe('deleteEmptyTags', () => {
    it('single tag exists, not connected to any assets, and is deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const tagRepo = ctx.get(TagRepository);
      const [tag] = await upsertTags(tagRepo, { userId: user.id, tags: ['tag-1'] });

      await expect(tagRepo.getByValue(user.id, 'tag-1')).resolves.toEqual(expect.objectContaining({ id: tag.id }));
      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);
      await expect(tagRepo.getByValue(user.id, 'tag-1')).resolves.toBeUndefined();
    });

    it('single tag exists, connected to one asset, and is not deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const tagRepo = ctx.get(TagRepository);
      const [tag] = await upsertTags(tagRepo, { userId: user.id, tags: ['tag-1'] });

      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });

      await expect(tagRepo.getByValue(user.id, 'tag-1')).resolves.toEqual(expect.objectContaining({ id: tag.id }));
      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);
      await expect(tagRepo.getByValue(user.id, 'tag-1')).resolves.toEqual(expect.objectContaining({ id: tag.id }));
    });

    it('hierarchical tag exists, and the parent is connected to an asset, and the child is deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const tagRepo = ctx.get(TagRepository);
      const [parentTag, childTag] = await upsertTags(tagRepo, { userId: user.id, tags: ['parent', 'parent/child'] });

      await ctx.newTagAsset({ tagIds: [parentTag.id], assetIds: [asset.id] });

      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toEqual(
        expect.objectContaining({ id: parentTag.id }),
      );
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toEqual(
        expect.objectContaining({ id: childTag.id }),
      );
      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);
      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toEqual(
        expect.objectContaining({ id: parentTag.id }),
      );
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toBeUndefined();
    });

    it('hierarchical tag exists, and only the child is connected to an asset, and nothing is deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const tagRepo = ctx.get(TagRepository);
      const [parentTag, childTag] = await upsertTags(tagRepo, { userId: user.id, tags: ['parent', 'parent/child'] });

      await ctx.newTagAsset({ tagIds: [childTag.id], assetIds: [asset.id] });

      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toEqual(
        expect.objectContaining({ id: parentTag.id }),
      );
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toEqual(
        expect.objectContaining({ id: childTag.id }),
      );
      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);
      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toEqual(
        expect.objectContaining({ id: parentTag.id }),
      );
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toEqual(
        expect.objectContaining({ id: childTag.id }),
      );
    });

    it('hierarchical tag exists, and neither parent nor child is connected to an asset, and both are deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const tagRepo = ctx.get(TagRepository);
      const [parentTag, childTag] = await upsertTags(tagRepo, { userId: user.id, tags: ['parent', 'parent/child'] });

      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toEqual(
        expect.objectContaining({ id: parentTag.id }),
      );
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toEqual(
        expect.objectContaining({ id: childTag.id }),
      );
      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toBeUndefined();
      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toBeUndefined();
    });
  });
});
