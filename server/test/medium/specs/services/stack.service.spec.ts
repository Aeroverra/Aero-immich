import { Kysely } from 'kysely';
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
});
