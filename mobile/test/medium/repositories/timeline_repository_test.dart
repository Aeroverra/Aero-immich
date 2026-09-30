import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/map.model.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';
import 'package:immich_mobile/infrastructure/repositories/remote_asset.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/timeline.repository.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import '../repository_context.dart';

void main() {
  late MediumRepositoryContext ctx;
  late TimelineRepository sut;

  setUpAll(() async {
    await initializeDateFormatting();
  });

  setUp(() {
    ctx = MediumRepositoryContext();
    sut = TimelineRepository(ctx.db);
  });

  tearDown(() async {
    await ctx.dispose();
  });

  group('remoteAlbum assets', () {
    test('no duplicate assets when identical checksum appears in multiple local asset rows', () async {
      // Regression check for #23273: a LEFT OUTER JOIN on checksum would fan out and create duplicates
      // happens when same photo exists in multiple albums on device
      final user = await ctx.newUser();
      const checksum = 'yolo';
      final album = await ctx.newRemoteAlbum(ownerId: user.id);
      final remoteAsset = await ctx.newRemoteAsset(ownerId: user.id, checksum: checksum);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: remoteAsset.id);

      final localAsset1 = await ctx.newLocalAsset(checksum: checksum);
      final localAsset2 = await ctx.newLocalAsset(checksum: checksum);

      final query = sut.remoteAlbum(album.id, .day);

      final buckets = await query.bucketSource().first;
      expect(buckets, hasLength(1));
      expect(buckets.single.assetCount, 1);

      final assets = await query.assetSource(0, 10);
      expect(assets, hasLength(1));
      expect((assets.first as RemoteAsset).id, remoteAsset.id);
      expect([localAsset1.id, localAsset2.id], contains((assets.first as RemoteAsset).localId));
    });

    test('orders shifted album assets in both directions and keeps normal asset order (#28852)', () async {
      final user = await ctx.newUser();
      final descendingAlbum = await ctx.newRemoteAlbum(ownerId: user.id, order: .desc);
      final ascendingAlbum = await ctx.newRemoteAlbum(ownerId: user.id, order: .asc);
      final shiftedLater = await ctx.newRemoteAsset(
        ownerId: user.id,
        createdAt: DateTime.utc(2024, 9, 2, 12),
        localDateTime: DateTime.utc(2024, 9, 3, 12),
      );
      final shiftedEarlier = await ctx.newRemoteAsset(
        ownerId: user.id,
        createdAt: DateTime.utc(2024, 9, 3, 12),
        localDateTime: DateTime.utc(2024, 9, 2, 12),
      );
      final normalLater = await ctx.newRemoteAsset(
        ownerId: user.id,
        createdAt: DateTime.utc(2024, 9, 4, 14),
        localDateTime: DateTime.utc(2024, 9, 4, 14),
      );
      final normalEarlier = await ctx.newRemoteAsset(
        ownerId: user.id,
        createdAt: DateTime.utc(2024, 9, 4, 12),
        localDateTime: DateTime.utc(2024, 9, 4, 12),
      );
      final seeded = [shiftedLater, shiftedEarlier, normalLater, normalEarlier];
      for (final asset in seeded) {
        await ctx.newRemoteAlbumAsset(albumId: descendingAlbum.id, assetId: asset.id);
        await ctx.newRemoteAlbumAsset(albumId: ascendingAlbum.id, assetId: asset.id);
      }

      final descending = sut.remoteAlbum(descendingAlbum.id, .day);
      final ascending = sut.remoteAlbum(ascendingAlbum.id, .day);

      final buckets = await descending.bucketSource().first;
      expect(buckets, hasLength(3));
      expect(buckets.map((bucket) => bucket.assetCount), [2, 1, 1]);

      final descendingAssets = await descending.assetSource(0, 10);
      expect(descendingAssets.map((asset) => (asset as RemoteAsset).id), [
        normalLater.id,
        normalEarlier.id,
        shiftedLater.id,
        shiftedEarlier.id,
      ]);

      final ascendingAssets = await ascending.assetSource(0, 10);
      expect(ascendingAssets.map((asset) => (asset as RemoteAsset).id), [
        shiftedEarlier.id,
        shiftedLater.id,
        normalEarlier.id,
        normalLater.id,
      ]);
    });
  });

  group('person assets', () {
    test('does not duplicate an asset that has multiple face records for the same person', () async {
      // Regression check for #26723: an INNER JOIN between remote_asset_entity and asset_face_entity
      // fanned out one asset into N rows when N face records pointed at the same (asset, person) pair
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(ownerId: user.id);

      final person = await ctx.newPerson(ownerId: user.id);
      await ctx.newFace(assetId: asset.id, personId: person.id);
      await ctx.newFace(assetId: asset.id, personId: person.id);

      final query = sut.person(user.id, person.id, .day);

      final buckets = await query.bucketSource().first;
      expect(buckets, hasLength(1));
      expect(buckets.single.assetCount, 1);

      final assets = await query.assetSource(0, 10);
      expect(assets, hasLength(1));
      expect((assets.first as RemoteAsset).id, asset.id);
    });

    test('orders shifted person assets by effective date (#28852)', () async {
      final user = await ctx.newUser();
      final person = await ctx.newPerson(ownerId: user.id);
      final shiftedLater = await ctx.newRemoteAsset(
        ownerId: user.id,
        createdAt: DateTime.utc(2024, 9, 2, 12),
        localDateTime: DateTime.utc(2024, 9, 3, 12),
      );
      final shiftedEarlier = await ctx.newRemoteAsset(
        ownerId: user.id,
        createdAt: DateTime.utc(2024, 9, 3, 12),
        localDateTime: DateTime.utc(2024, 9, 2, 12),
      );
      await ctx.newFace(assetId: shiftedLater.id, personId: person.id);
      await ctx.newFace(assetId: shiftedEarlier.id, personId: person.id);

      final query = sut.person(user.id, person.id, .day);

      final buckets = await query.bucketSource().first;
      expect(buckets, hasLength(2));

      final assets = await query.assetSource(0, 10);
      expect(assets.map((asset) => (asset as RemoteAsset).id), [shiftedLater.id, shiftedEarlier.id]);
    });
  });

  group('private mode', () {
    Future<List<String>> idsOf(TimelineQuery query) async {
      final buckets = await query.bucketSource().first;
      final total = buckets.fold<int>(0, (sum, bucket) => sum + bucket.assetCount);
      final assets = await query.assetSource(0, 100);
      expect(assets, hasLength(total), reason: 'bucket count and asset count agree for ${query.origin}');
      return assets.map((asset) => (asset as RemoteAsset).id).toList();
    }

    test('hides own private assets when off and shows them when on, for every origin', () async {
      final user = await ctx.newUser();
      final person = await ctx.newPerson(ownerId: user.id);
      // a private album would be hidden as a whole, the asset level rule is exercised on a public one
      final album = await ctx.newRemoteAlbum(ownerId: user.id);
      final world = LatLngBounds(southwest: const LatLng(-80, -170), northeast: const LatLng(80, 170));
      final mapOptions = TimelineMapOptions(bounds: world);
      final on = PrivateModeFilter(enabled: true, userId: user.id);

      final origins = <String, TimelineQuery Function(PrivateModeFilter filter)>{
        'main': (filter) => sut.main([user.id], .day, privateFilter: filter),
        'remote': (filter) => sut.remote(user.id, .day, privateFilter: filter),
        'favorite': (filter) => sut.favorite(user.id, .day, privateFilter: filter),
        'trash': (filter) => sut.trash(user.id, .day, privateFilter: filter),
        'archived': (filter) => sut.archived(user.id, .day, privateFilter: filter),
        'video': (filter) => sut.video(user.id, .day, privateFilter: filter),
        'recentlyAdded': (filter) => sut.recentlyAdded(user.id, .day, privateFilter: filter),
        'album': (filter) => sut.remoteAlbum(album.id, .day, privateFilter: filter),
        'albumUngrouped': (filter) => sut.remoteAlbum(album.id, .none, privateFilter: filter),
        'person': (filter) => sut.person(user.id, person.id, .day, privateFilter: filter),
        'place': (filter) => sut.place('Berlin', .day, privateFilter: filter),
        'map': (filter) =>
            sut.geographicMap([user.id], () => mapOptions, const Stream.empty(), .day, privateFilter: filter),
      };

      // one public + one private asset per origin, shaped so that the origin's own filter matches them
      for (final entry in origins.entries) {
        final origin = entry.key;
        final isVideo = origin == 'video';
        final isTrash = origin == 'trash';
        final isArchived = origin == 'archived';
        final isFavorite = origin == 'favorite';
        final ids = <bool, String>{};
        for (final isPrivate in [false, true]) {
          final asset = await ctx.newRemoteAsset(
            ownerId: user.id,
            isPrivate: isPrivate,
            isFavorite: isFavorite,
            type: isVideo ? .video : .image,
            visibility: isArchived ? .archive : .timeline,
            deletedAt: isTrash ? DateTime.now() : null,
          );
          await ctx.db.customStatement(
            "UPDATE remote_asset_entity SET uploaded_at = created_at WHERE id = '${asset.id}'",
          );
          await ctx.newFace(assetId: asset.id, personId: person.id);
          if (!isTrash) {
            // the ungrouped album count does not exclude trashed assets, keep the album consistent
            await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: asset.id);
          }
          await ctx.newRemoteExif(assetId: asset.id, city: 'Berlin', latitude: 1, longitude: 1);
          ids[isPrivate] = asset.id;
        }

        final off = await idsOf(entry.value(PrivateModeFilter.off));
        expect(off, contains(ids[false]), reason: '$origin shows the public asset when off');
        expect(off, isNot(contains(ids[true])), reason: '$origin hides the private asset when off');

        final shown = await idsOf(entry.value(on));
        expect(shown, contains(ids[false]), reason: '$origin shows the public asset when on');
        expect(shown, contains(ids[true]), reason: '$origin shows the private asset when on');
      }
    });

    test('never shows a partner private asset, on or off', () async {
      final user = await ctx.newUser();
      final partner = await ctx.newUser();
      await ctx.newPartner(sharedById: partner.id, sharedWithId: user.id, inTimeline: true);
      final partnerPublic = await ctx.newRemoteAsset(ownerId: partner.id);
      final partnerPrivate = await ctx.newRemoteAsset(ownerId: partner.id, isPrivate: true);
      await ctx.newRemoteExif(assetId: partnerPublic.id, city: 'Berlin', latitude: 1, longitude: 1);
      await ctx.newRemoteExif(assetId: partnerPrivate.id, city: 'Berlin', latitude: 1, longitude: 1);
      final world = LatLngBounds(southwest: const LatLng(-80, -170), northeast: const LatLng(80, 170));
      final mapOptions = TimelineMapOptions(bounds: world);

      for (final filter in [PrivateModeFilter.off, PrivateModeFilter(enabled: true, userId: user.id)]) {
        final main = await idsOf(sut.main([user.id, partner.id], .day, privateFilter: filter));
        expect(main, [partnerPublic.id], reason: 'main with $filter');

        final place = await idsOf(sut.place('Berlin', .day, privateFilter: filter));
        expect(place, [partnerPublic.id], reason: 'place with $filter');

        final map = await idsOf(
          sut.geographicMap([user.id, partner.id], () => mapOptions, const Stream.empty(), .day, privateFilter: filter),
        );
        expect(map, [partnerPublic.id], reason: 'map with $filter');
      }
    });

    test('a private album has no timeline while off and a full one once the mode is on, for both groupings', () async {
      final user = await ctx.newUser();
      final album = await ctx.newRemoteAlbum(ownerId: user.id, isPrivate: true);
      final public = await ctx.newRemoteAsset(ownerId: user.id);
      final private = await ctx.newRemoteAsset(ownerId: user.id, isPrivate: true);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: public.id);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: private.id);
      final on = PrivateModeFilter(enabled: true, userId: user.id);

      for (final groupBy in [GroupAssetsBy.day, GroupAssetsBy.none]) {
        final offQuery = sut.remoteAlbum(album.id, groupBy, privateFilter: PrivateModeFilter.off);
        expect(await offQuery.bucketSource().first, isEmpty, reason: 'no buckets while off ($groupBy)');
        expect(await offQuery.assetSource(0, 10), isEmpty, reason: 'no assets while off ($groupBy)');

        final shown = await idsOf(sut.remoteAlbum(album.id, groupBy, privateFilter: on));
        expect(shown, containsAll([public.id, private.id]), reason: 'everything once on ($groupBy)');
        expect(shown, hasLength(2));
      }
    });

    test('a partner private album follows the same album rule: hidden while off, complete when on', () async {
      final user = await ctx.newUser();
      final partner = await ctx.newUser();
      final album = await ctx.newRemoteAlbum(ownerId: partner.id, isPrivate: true);
      final partnerPublic = await ctx.newRemoteAsset(ownerId: partner.id);
      final partnerPrivate = await ctx.newRemoteAsset(ownerId: partner.id, isPrivate: true);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: partnerPublic.id);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: partnerPrivate.id);

      final off = await idsOf(sut.remoteAlbum(album.id, .day, privateFilter: PrivateModeFilter.off));
      expect(off, isEmpty);

      final on = await idsOf(
        sut.remoteAlbum(album.id, .day, privateFilter: PrivateModeFilter(enabled: true, userId: user.id)),
      );
      expect(on, containsAll([partnerPublic.id, partnerPrivate.id]));
      expect(on, hasLength(2));
    });

    test('an asset marked private while off drops out of the filtered timeline queries', () async {
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(ownerId: user.id, isFavorite: true);
      final assets = RemoteAssetRepository(ctx.db);

      expect(await idsOf(sut.main([user.id], .day)), [asset.id]);
      expect(await idsOf(sut.favorite(user.id, .day)), [asset.id]);

      await assets.updateAssets([asset.id], isPrivate: const .some(true));

      expect(await idsOf(sut.main([user.id], .day)), isEmpty);
      expect(await idsOf(sut.favorite(user.id, .day)), isEmpty);
      expect(await idsOf(sut.remote(user.id, .day)), isEmpty);
      final on = PrivateModeFilter(enabled: true, userId: user.id);
      expect(await idsOf(sut.main([user.id], .day, privateFilter: on)), [asset.id]);
      expect(await idsOf(sut.privateFolder(user.id, .day, privateFilter: on)), [asset.id]);
    });

    test('privateFolder lists only own private assets and only while the mode is on', () async {
      final user = await ctx.newUser();
      final partner = await ctx.newUser();
      final public = await ctx.newRemoteAsset(ownerId: user.id);
      final private = await ctx.newRemoteAsset(ownerId: user.id, isPrivate: true);
      final archivedPrivate = await ctx.newRemoteAsset(ownerId: user.id, isPrivate: true, visibility: .archive);
      await ctx.newRemoteAsset(ownerId: user.id, isPrivate: true, deletedAt: DateTime.now());
      await ctx.newRemoteAsset(ownerId: partner.id, isPrivate: true);

      final query = sut.privateFolder(user.id, .day, privateFilter: PrivateModeFilter(enabled: true, userId: user.id));
      expect(query.origin, TimelineOrigin.privateFolder);
      final on = await idsOf(query);
      expect(on, containsAll([private.id, archivedPrivate.id]));
      expect(on, hasLength(2));
      expect(on, isNot(contains(public.id)));

      final off = await idsOf(sut.privateFolder(user.id, .day));
      expect(off, isEmpty);
    });

    test('main timeline carries isPrivate on the returned asset', () async {
      final user = await ctx.newUser();
      final private = await ctx.newRemoteAsset(ownerId: user.id, isPrivate: true);

      final assets = await sut
          .main([user.id], .day, privateFilter: PrivateModeFilter(enabled: true, userId: user.id))
          .assetSource(0, 10);

      expect(assets, hasLength(1));
      final remote = assets.single as RemoteAsset;
      expect(remote.id, private.id);
      expect(remote.isPrivate, isTrue);
    });
  });

  group('live photos', () {
    test('remote-only live photo contains livePhotoVideoId and is marked as a motion photo', () async {
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(ownerId: user.id, livePhotoVideoId: 'motion-photo-1');

      final assets = await sut.main([user.id], .day).assetSource(0, 10);

      expect(assets, hasLength(1));
      final remote = assets.single as RemoteAsset;
      expect(remote.id, asset.id);
      expect(remote.livePhotoVideoId, 'motion-photo-1');
      expect(remote.isMotionPhoto, isTrue);
      expect(remote.localId, isNull);
    });

    test('merged live photo resolves localId and is marked as a motion photo', () async {
      final user = await ctx.newUser();
      const checksum = 'shared-live-photo-checksum';
      final asset = await ctx.newRemoteAsset(ownerId: user.id, checksum: checksum, livePhotoVideoId: 'motion-photo-2');
      final local = await ctx.newLocalAsset(checksum: checksum);

      final assets = await sut.main([user.id], .day).assetSource(0, 10);

      expect(assets, hasLength(1));
      final remote = assets.single as RemoteAsset;
      expect(remote.id, asset.id);
      expect(remote.livePhotoVideoId, 'motion-photo-2');
      expect(remote.isMotionPhoto, isTrue);
      expect(remote.localId, local.id);
    });
  });

  group('localAlbum assets', () {
    late String userId;
    late String otherUserId;

    setUp(() async {
      final user = await ctx.newUser();
      userId = user.id;
      await ctx.newAuthUser(id: userId);
      final other = await ctx.newUser();
      otherUserId = other.id;
    });

    test('does not duplicate assets when a partner shares the checksum', () async {
      const checksum = 'shared-partner-checksum';
      final album = await ctx.newLocalAlbum();
      final local = await ctx.newLocalAsset(checksum: checksum);
      await ctx.newLocalAlbumAsset(albumId: album.id, assetId: local.id);
      final myRemote = await ctx.newRemoteAsset(ownerId: userId, checksum: checksum);
      await ctx.newRemoteAsset(ownerId: otherUserId, checksum: checksum);

      final assets = await sut.localAlbum(album.id, .day).assetSource(0, 10);

      expect(assets, hasLength(1));
      final asset = assets.single as LocalAsset;
      expect(asset.id, local.id);
      // Must resolve the current user's remote id
      expect(asset.remoteId, myRemote.id);
    });

    test('bucket count ignores a partner sharing the checksum', () async {
      const checksum = 'shared-partner-checksum';
      final album = await ctx.newLocalAlbum();
      final local = await ctx.newLocalAsset(checksum: checksum);
      await ctx.newLocalAlbumAsset(albumId: album.id, assetId: local.id);
      await ctx.newRemoteAsset(ownerId: userId, checksum: checksum);
      await ctx.newRemoteAsset(ownerId: otherUserId, checksum: checksum);

      final buckets = await sut.localAlbum(album.id, .day).bucketSource().first;

      expect(buckets, hasLength(1));
      expect(buckets.single.assetCount, 1);
    });
  });
}
