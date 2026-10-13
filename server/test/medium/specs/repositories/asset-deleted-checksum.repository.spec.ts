import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { AssetStatus, DeletedReimportMode } from 'src/enum';
import { AssetDeletedChecksumRepository } from 'src/repositories/asset-deleted-checksum.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { DB } from 'src/schema';
import { BaseService } from 'src/services/base.service';
import { newMediumService } from 'test/medium.factory';
import { newUuid } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const newChecksum = () => randomBytes(20);

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AssetDeletedChecksumRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AssetDeletedChecksumRepository.name, () => {
  describe('upsert', () => {
    it('should remember a checksum per owner', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const checksum = newChecksum();

      await sut.upsert({ ownerId: user.id, checksum, assetId: newUuid(), originalFileName: 'photo.jpg' });

      await expect(sut.get(user.id, checksum)).resolves.toEqual(
        expect.objectContaining({ originalFileName: 'photo.jpg' }),
      );
      await expect(sut.get(otherUser.id, checksum)).resolves.toBeUndefined();
      await expect(sut.getCount(user.id)).resolves.toBe(1);
    });

    it('should reset a pending notification when the same checksum is deleted again', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const checksum = newChecksum();

      await sut.upsert({ ownerId: user.id, checksum, assetId: newUuid(), originalFileName: 'photo.jpg' });
      await sut.markReimported(user.id, checksum, DeletedReimportMode.Trash);
      await expect(sut.getPendingNotification(user.id)).resolves.toEqual([
        { reimportMode: DeletedReimportMode.Trash, count: 1 },
      ]);

      await sut.upsert({ ownerId: user.id, checksum, assetId: newUuid(), originalFileName: 'photo-2.jpg' });

      await expect(sut.getPendingNotification(user.id)).resolves.toEqual([]);
      await expect(sut.getCount(user.id)).resolves.toBe(1);
    });
  });

  describe('getByChecksums', () => {
    it('should only return the remembered checksums of the owner', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const remembered = newChecksum();
      const foreign = newChecksum();
      const assetId = newUuid();

      await sut.upsert({ ownerId: user.id, checksum: remembered, assetId, originalFileName: 'a.jpg' });
      await sut.upsert({ ownerId: otherUser.id, checksum: foreign, assetId: newUuid(), originalFileName: 'b.jpg' });

      await expect(sut.getByChecksums(user.id, [remembered, foreign, newChecksum()])).resolves.toEqual([
        { checksum: remembered, assetId },
      ]);
      await expect(sut.getByChecksums(user.id, [])).resolves.toEqual([]);
    });
  });

  describe('markNotified', () => {
    it('should count the re-uploads per mode until they are notified', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const checksums = [newChecksum(), newChecksum(), newChecksum()];
      for (const checksum of checksums) {
        await sut.upsert({ ownerId: user.id, checksum, assetId: newUuid(), originalFileName: 'a.jpg' });
      }

      await sut.markReimported(user.id, checksums[0], DeletedReimportMode.Trash);
      await sut.markReimported(user.id, checksums[1], DeletedReimportMode.Trash);
      await sut.markReimported(user.id, checksums[2], DeletedReimportMode.Album);

      await expect(sut.getPendingNotification(user.id)).resolves.toEqual(
        expect.arrayContaining([
          { reimportMode: DeletedReimportMode.Trash, count: 2 },
          { reimportMode: DeletedReimportMode.Album, count: 1 },
        ]),
      );

      await sut.markNotified(user.id);

      await expect(sut.getPendingNotification(user.id)).resolves.toEqual([]);

      await sut.markReimported(user.id, checksums[2], DeletedReimportMode.Album);

      await expect(sut.getPendingNotification(user.id)).resolves.toEqual([
        { reimportMode: DeletedReimportMode.Album, count: 1 },
      ]);
    });
  });

  describe('forgetAssets', () => {
    it('should forget the checksums of the given assets of their owner', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const checksum = newChecksum();
      const { asset } = await ctx.newAsset({ ownerId: user.id, checksum });
      const { asset: otherAsset } = await ctx.newAsset({ ownerId: user.id });

      await sut.upsert({ ownerId: user.id, checksum, assetId: newUuid(), originalFileName: 'a.jpg' });
      await sut.upsert({ ownerId: otherUser.id, checksum, assetId: newUuid(), originalFileName: 'a.jpg' });

      await sut.forgetAssets([otherAsset.id]);
      await expect(sut.getCount(user.id)).resolves.toBe(1);

      await sut.forgetAssets([asset.id]);
      await expect(sut.getCount(user.id)).resolves.toBe(0);
      await expect(sut.getCount(otherUser.id)).resolves.toBe(1);
    });
  });

  describe('forgetTrashed', () => {
    it('should forget the checksums of the trashed assets of the owner only', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const trashed = newChecksum();
      const active = newChecksum();
      const unrelated = newChecksum();
      await ctx.newAsset({ ownerId: user.id, checksum: trashed, status: AssetStatus.Trashed, deletedAt: new Date() });
      await ctx.newAsset({ ownerId: user.id, checksum: active });
      for (const checksum of [trashed, active, unrelated]) {
        await sut.upsert({ ownerId: user.id, checksum, assetId: newUuid(), originalFileName: 'a.jpg' });
      }

      await sut.forgetTrashed(user.id);

      await expect(sut.get(user.id, trashed)).resolves.toBeUndefined();
      await expect(sut.get(user.id, active)).resolves.toBeDefined();
      await expect(sut.get(user.id, unrelated)).resolves.toBeDefined();
    });
  });

  describe('deleteAll', () => {
    it('should forget everything of the owner and nothing of other users', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      await sut.upsert({ ownerId: user.id, checksum: newChecksum(), assetId: newUuid(), originalFileName: 'a.jpg' });
      await sut.upsert({ ownerId: user.id, checksum: newChecksum(), assetId: newUuid(), originalFileName: 'b.jpg' });
      await sut.upsert({
        ownerId: otherUser.id,
        checksum: newChecksum(),
        assetId: newUuid(),
        originalFileName: 'c.jpg',
      });

      await sut.deleteAll(user.id);

      await expect(sut.getCount(user.id)).resolves.toBe(0);
      await expect(sut.getCount(otherUser.id)).resolves.toBe(1);
    });

    it('should be removed with the user', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      await sut.upsert({ ownerId: user.id, checksum: newChecksum(), assetId: newUuid(), originalFileName: 'a.jpg' });

      await ctx.database.deleteFrom('user').where('id', '=', user.id).execute();

      await expect(
        ctx.database.selectFrom('asset_deleted_checksum').selectAll().where('ownerId', '=', user.id).execute(),
      ).resolves.toEqual([]);
    });
  });
});
