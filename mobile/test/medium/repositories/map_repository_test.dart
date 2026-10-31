import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/map.model.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/infrastructure/repositories/map.repository.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import '../repository_context.dart';

void main() {
  late MediumRepositoryContext ctx;
  late MapRepository sut;

  setUp(() {
    ctx = MediumRepositoryContext();
    sut = MapRepository(ctx.db);
  });

  tearDown(() async {
    await ctx.dispose();
  });

  final world = LatLngBounds(southwest: const LatLng(-80, -170), northeast: const LatLng(80, 170));

  group('remote markers with private mode', () {
    test('hides private assets when private mode is off and shows own ones when on', () async {
      final user = await ctx.newUser();
      final public = await ctx.newRemoteAsset(ownerId: user.id);
      final private = await ctx.newRemoteAsset(ownerId: user.id, isPrivate: true);
      await ctx.newRemoteExif(assetId: public.id, latitude: 10, longitude: 10);
      await ctx.newRemoteExif(assetId: private.id, latitude: 20, longitude: 20);

      final off = await sut.remote([user.id], TimelineMapOptions(bounds: world)).markerSource(null);
      expect(off.map((marker) => marker.assetId), [public.id]);

      final on = await sut
          .remote(
            [user.id],
            TimelineMapOptions(bounds: world),
            privateFilter: .new(enabled: true, userId: user.id),
          )
          .markerSource(null);
      expect(on.map((marker) => marker.assetId), containsAll([public.id, private.id]));
      expect(on, hasLength(2));
    });

    test('never shows a partner private asset', () async {
      final user = await ctx.newUser();
      final partner = await ctx.newUser();
      await ctx.newPartner(sharedById: partner.id, sharedWithId: user.id, inTimeline: true);
      final partnerPublic = await ctx.newRemoteAsset(ownerId: partner.id);
      final partnerPrivate = await ctx.newRemoteAsset(ownerId: partner.id, isPrivate: true);
      await ctx.newRemoteExif(assetId: partnerPublic.id, latitude: 10, longitude: 10);
      await ctx.newRemoteExif(assetId: partnerPrivate.id, latitude: 20, longitude: 20);

      for (final filter in [PrivateModeFilter.off, PrivateModeFilter(enabled: true, userId: user.id)]) {
        final markers = await sut
            .remote([user.id, partner.id], TimelineMapOptions(bounds: world), privateFilter: filter)
            .markerSource(null);
        expect(markers.map((marker) => marker.assetId), [partnerPublic.id], reason: 'filter $filter');
      }
    });
  });
}
