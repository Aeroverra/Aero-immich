import { Kysely } from 'kysely';
import { StackSource, StackUserEditAction } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { StackRepository } from 'src/repositories/stack.repository';
import { DB } from 'src/schema';
import { StackService } from 'src/services/stack.service';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(StackService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AssetRepository, StackRepository],
    mock: [EventRepository, LoggingRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(StackService.name, () => {
  describe('create', () => {
    it('should not stack an asset of another user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: otherAsset } = await ctx.newAsset({ ownerId: otherUser.id });

      await expect(sut.create(factory.auth({ user }), { assetIds: [asset.id, otherAsset.id] })).rejects.toThrow(
        'Not found or no asset.update access',
      );
      await expect(
        ctx.database.selectFrom('stack').selectAll().where('ownerId', '=', user.id).execute(),
      ).resolves.toEqual([]);
    });
  });

  describe('private mode', () => {
    it('should mark every member private when a stack is created with a private member', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      await ctx.newExif({ assetId: plain.id, make: 'Canon' });
      await ctx.newExif({ assetId: hidden.id, make: 'Canon' });

      const stack = await sut.create(factory.auth({ user, session: { privateMode: true } }), {
        assetIds: [plain.id, hidden.id],
      });

      expect(stack.assets).toHaveLength(2);
      expect(stack.assets.every(({ isPrivate }) => isPrivate)).toBe(true);
      const rows = await ctx.database
        .selectFrom('asset')
        .select(['id', 'isPrivate'])
        .where('id', 'in', [plain.id, hidden.id])
        .execute();
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: plain.id, isPrivate: true },
          { id: hidden.id, isPrivate: true },
        ]),
      );

      // the stack is now fully private, so it is hidden outside private mode
      await expect(sut.search(factory.auth({ user }), {})).resolves.toEqual([]);
    });

    it('should not touch the private flag when no member is private', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: first } = await ctx.newAsset({ ownerId: user.id });
      const { asset: second } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: first.id, make: 'Canon' });
      await ctx.newExif({ assetId: second.id, make: 'Canon' });

      const stack = await sut.create(factory.auth({ user }), { assetIds: [first.id, second.id] });

      expect(stack.assets.map(({ isPrivate }) => isPrivate)).toEqual([false, false]);
    });

    it('should omit a stack whose primary asset is private outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: hidden.id, make: 'Canon' });
      await ctx.newExif({ assetId: plain.id, make: 'Canon' });
      const { stack } = await ctx.newStack({ ownerId: user.id }, [hidden.id, plain.id]);

      await expect(sut.search(factory.auth({ user }), {})).resolves.toEqual([]);

      const on = await sut.search(factory.auth({ user, session: { privateMode: true } }), {});
      expect(on).toEqual([expect.objectContaining({ id: stack.id, primaryAssetId: hidden.id })]);
      expect(on[0].assets).toHaveLength(2);
    });

    it('should hide private children of a stack outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      await ctx.newExif({ assetId: plain.id, make: 'Canon' });
      await ctx.newExif({ assetId: hidden.id, make: 'Canon' });
      const { stack } = await ctx.newStack({ ownerId: user.id }, [plain.id, hidden.id]);

      const [found] = await sut.search(factory.auth({ user }), {});
      expect(found).toMatchObject({ id: stack.id, primaryAssetId: plain.id });
      expect(found.assets.map(({ id }) => id)).toEqual([plain.id]);
      await expect(sut.get(factory.auth({ user }), stack.id)).resolves.toMatchObject({
        assets: [expect.objectContaining({ id: plain.id })],
      });

      const full = await sut.get(factory.auth({ user, session: { privateMode: true } }), stack.id);
      expect(full.assets).toHaveLength(2);
    });
  });

  describe('source', () => {
    it('should create manual stacks through the API and keep the source of automatic stacks', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset3 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset4 } = await ctx.newAsset({ ownerId: user.id });
      for (const asset of [asset1, asset2, asset3, asset4]) {
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      }

      await expect(sut.create(auth, { assetIds: [asset1.id, asset2.id] })).resolves.toMatchObject({
        source: StackSource.Manual,
      });
      const { stack: auto } = await ctx.newStack({ ownerId: user.id, source: StackSource.Auto }, [
        asset3.id,
        asset4.id,
      ]);

      await expect(sut.get(auth, auto.id)).resolves.toMatchObject({ id: auto.id, source: StackSource.Auto });
    });

    it('should report the members of a deleted automatic stack, trashed ones included', async () => {
      const { sut, ctx } = setup();
      const emit = ctx.getMock(EventRepository).emit;
      emit.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: trashed } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
      const { stack } = await ctx.newStack({ ownerId: user.id, source: StackSource.Auto }, [
        asset1.id,
        asset2.id,
        trashed.id,
      ]);

      await sut.delete(factory.auth({ user }), stack.id);

      expect(emit).toHaveBeenCalledWith('StackUserEdit', {
        userId: user.id,
        stackId: stack.id,
        source: StackSource.Auto,
        action: StackUserEditAction.Delete,
        assetIds: expect.arrayContaining([asset1.id, asset2.id, trashed.id]),
      });
    });

    it('should report an asset taken out of an automatic stack', async () => {
      const { sut, ctx } = setup();
      const emit = ctx.getMock(EventRepository).emit;
      emit.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset3 } = await ctx.newAsset({ ownerId: user.id });
      const { stack } = await ctx.newStack({ ownerId: user.id, source: StackSource.Auto }, [
        asset1.id,
        asset2.id,
        asset3.id,
      ]);

      await sut.removeAsset(factory.auth({ user }), { id: stack.id, assetId: asset3.id });

      expect(emit).toHaveBeenCalledWith('StackUserEdit', {
        userId: user.id,
        stackId: stack.id,
        source: StackSource.Auto,
        action: StackUserEditAction.RemoveAssets,
        assetIds: [asset3.id],
      });
    });

    it('should report an automatic stack merged into a new manual stack', async () => {
      const { sut, ctx } = setup();
      const emit = ctx.getMock(EventRepository).emit;
      emit.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: other } = await ctx.newAsset({ ownerId: user.id });
      for (const asset of [asset1, asset2, other]) {
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      }
      const { stack: auto } = await ctx.newStack({ ownerId: user.id, source: StackSource.Auto }, [
        asset1.id,
        asset2.id,
      ]);

      const created = await sut.create(factory.auth({ user }), { assetIds: [other.id, asset1.id] });

      expect(created.source).toBe(StackSource.Manual);
      expect(created.assets.map(({ id }) => id).sort()).toEqual([asset1.id, asset2.id, other.id].sort());
      expect(emit).toHaveBeenCalledWith('StackUserEdit', {
        userId: user.id,
        stackId: auto.id,
        source: StackSource.Auto,
        action: StackUserEditAction.Merge,
        assetIds: expect.arrayContaining([asset1.id, asset2.id]),
        targetStackId: created.id,
      });
    });
  });
});
