import { Kysely } from 'kysely';
import { AlbumRepository } from 'src/repositories/album.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { DB } from 'src/schema';
import { BaseService } from 'src/services/base.service';
import { newMediumService } from 'test/medium.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AlbumRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AlbumRepository.name, () => {
  describe('getAlbumUserIdsByAssetIds', () => {
    it('should list the owner and every shared user of the albums holding the assets', async () => {
      const { ctx, sut } = setup();
      const { album, asset, owner, sharedWith } = await ctx.newSharedAlbum();
      const { asset: loose } = await ctx.newAsset({ ownerId: owner.id });
      const { album: otherAlbum } = await ctx.newAlbum({ ownerId: owner.id }, [loose.id]);

      const rows = await sut.getAlbumUserIdsByAssetIds([asset.id, loose.id]);

      expect(rows).toHaveLength(3);
      expect(rows).toEqual(
        expect.arrayContaining([
          { albumId: album.id, userId: owner.id },
          { albumId: album.id, userId: sharedWith.id },
          { albumId: otherAlbum.id, userId: owner.id },
        ]),
      );
    });

    it('should skip deleted albums', async () => {
      const { ctx, sut } = setup();
      const { album, asset } = await ctx.newSharedAlbum();
      await ctx.softDeleteAlbum(album.id);

      await expect(sut.getAlbumUserIdsByAssetIds([asset.id])).resolves.toEqual([]);
    });

    it('should return nothing without assets', async () => {
      const { sut } = setup();

      await expect(sut.getAlbumUserIdsByAssetIds([])).resolves.toEqual([]);
    });
  });
});
