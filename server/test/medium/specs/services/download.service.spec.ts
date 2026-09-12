import { Kysely } from 'kysely';
import { AccessRepository } from 'src/repositories/access.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { DownloadRepository } from 'src/repositories/download.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { DB } from 'src/schema';
import { DownloadService } from 'src/services/download.service';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(DownloadService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AssetRepository, DownloadRepository, UserRepository],
    mock: [LoggingRepository],
  });
};

const newSizedAsset = async (ctx: ReturnType<typeof setup>['ctx'], ownerId: string, isPrivate: boolean) => {
  const { asset } = await ctx.newAsset({ ownerId, isPrivate });
  await ctx.newExif({ assetId: asset.id, fileSizeInByte: 1000 });
  return asset;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(DownloadService.name, () => {
  describe('getDownloadInfo', () => {
    it('should exclude private assets from an album download outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const plain = await newSizedAsset(ctx, user.id, false);
      const hidden = await newSizedAsset(ctx, user.id, true);
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [plain.id, hidden.id]);

      const off = await sut.getDownloadInfo(factory.auth({ user }), { albumId: album.id });
      expect(off.archives.flatMap(({ assetIds }) => assetIds)).toEqual([plain.id]);
      expect(Number(off.totalSize)).toBe(1000);

      const on = await sut.getDownloadInfo(factory.auth({ user, session: { privateMode: true } }), {
        albumId: album.id,
      });
      expect(on.archives.flatMap(({ assetIds }) => assetIds).sort()).toEqual([plain.id, hidden.id].sort());
      expect(Number(on.totalSize)).toBe(2000);
    });

    it('should exclude private assets from a user download outside private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const plain = await newSizedAsset(ctx, user.id, false);
      const hidden = await newSizedAsset(ctx, user.id, true);

      const off = await sut.getDownloadInfo(factory.auth({ user }), { userId: user.id });
      expect(off.archives.flatMap(({ assetIds }) => assetIds)).toEqual([plain.id]);

      const on = await sut.getDownloadInfo(factory.auth({ user, session: { privateMode: true } }), {
        userId: user.id,
      });
      expect(on.archives.flatMap(({ assetIds }) => assetIds).sort()).toEqual([plain.id, hidden.id].sort());
    });
  });
});
