import { Kysely } from 'kysely';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { MapRepository } from 'src/repositories/map.repository';
import { PartnerRepository } from 'src/repositories/partner.repository';
import { DB } from 'src/schema';
import { MapService } from 'src/services/map.service';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(MapService, {
    database: db || defaultDatabase,
    real: [AlbumRepository, AssetRepository, MapRepository, PartnerRepository],
    mock: [LoggingRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(MapService.name, () => {
  describe('getMapMarkers', () => {
    it('should show private markers only to their owner while in private mode', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
      const { asset: partnerHidden } = await ctx.newAsset({ ownerId: partner.id, isPrivate: true });
      await ctx.newExif({ assetId: plain.id, latitude: 1, longitude: 1 });
      await ctx.newExif({ assetId: hidden.id, latitude: 2, longitude: 2 });
      await ctx.newExif({ assetId: partnerHidden.id, latitude: 3, longitude: 3 });

      await expect(sut.getMapMarkers(factory.auth({ user }), { withPartners: true })).resolves.toEqual([
        expect.objectContaining({ id: plain.id }),
      ]);

      // the partner's private asset stays hidden even with private mode on
      const on = await sut.getMapMarkers(factory.auth({ user, session: { privateMode: true } }), {
        withPartners: true,
      });
      expect(on.map(({ id }) => id).sort()).toEqual([plain.id, hidden.id].sort());
    });
  });
});
