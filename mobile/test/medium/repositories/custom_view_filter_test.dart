import 'package:drift/drift.dart' hide isNull;
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/album/local_album.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/infrastructure/repositories/custom_view.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/remote_album.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/timeline.repository.dart';
import 'package:intl/date_symbol_data_local.dart';

import '../repository_context.dart';

void main() {
  late MediumRepositoryContext ctx;
  late TimelineRepository timeline;
  late RemoteAlbumRepository albums;
  late CustomViewRepository views;
  late String me;

  setUpAll(() async {
    await initializeDateFormatting();
  });

  setUp(() async {
    ctx = MediumRepositoryContext();
    timeline = TimelineRepository(ctx.db);
    albums = RemoteAlbumRepository(ctx.db);
    views = CustomViewRepository(ctx.db);
    me = (await ctx.newUser()).id;
  });

  tearDown(() async {
    await ctx.dispose();
  });

  Future<void> tag(String id, {String? parentId, bool isHidden = false, String? ownerId}) => views.upsertTag(
    TagEntry(
      id: id,
      ownerId: ownerId ?? me,
      value: parentId == null ? id : '$parentId/$id',
      parentId: parentId,
      isHidden: isHidden,
    ),
  );

  Future<String> asset(
    String id, {
    List<String> tags = const [],
    bool isPrivate = false,
    String? ownerId,
    int minute = 0,
    String? stackId,
  }) async {
    await ctx.newRemoteAsset(
      id: id,
      ownerId: ownerId ?? me,
      isPrivate: isPrivate,
      stackId: stackId,
      createdAt: DateTime.utc(2024, 1, 1, 12, minute),
    );
    await views.addTagAssets(tags, [id]);
    return id;
  }

  Future<PrivateModeFilter> filter(CustomView view, {bool privateMode = false}) async =>
      PrivateModeFilter(enabled: privateMode, userId: me, view: ViewFilter.fromView(view, await views.getTags(me)));

  Future<List<String>> mainIds(PrivateModeFilter privateFilter, {List<String>? userIds}) async {
    final query = timeline.main(userIds ?? [me], .day, privateFilter: privateFilter);
    final assets = await query.assetSource(0, 100);
    return assets.map((asset) => asset is RemoteAsset ? asset.id : (asset as LocalAsset).id).toList();
  }

  Future<int> mainCount(PrivateModeFilter privateFilter, {List<String>? userIds}) async {
    final buckets = await timeline.main(userIds ?? [me], .day, privateFilter: privateFilter).bucketSource().first;
    return buckets.fold<int>(0, (sum, bucket) => sum + bucket.assetCount);
  }

  group('rule', () {
    setUp(() async {
      await tag('Unreviewed');
      await tag('Gym');
      await tag('Progress', parentId: 'Gym');
      await tag('Travel');
      await asset('untagged');
      await asset('unreviewed', tags: ['Unreviewed']);
      await asset('progress', tags: ['Progress']);
      await asset('travel', tags: ['Travel']);
      await asset('travel-gym', tags: ['Travel', 'Gym']);
    });

    test('everything minus an exclude tag and its descendants', () async {
      final privateFilter = await filter(
        CustomView(id: 'v', ownerId: me, name: 'v', includeAll: true, excludeTagIds: const ['Unreviewed', 'Gym']),
      );

      expect(await mainIds(privateFilter), unorderedEquals(['untagged', 'travel']));
      expect(await mainCount(privateFilter), 2);
    });

    test('untagged or an include tag, exclude wins', () async {
      final privateFilter = await filter(
        CustomView(
          id: 'v',
          ownerId: me,
          name: 'v',
          includeAll: false,
          includeUntagged: true,
          includeTagIds: const ['Travel'],
          excludeTagIds: const ['Gym'],
        ),
      );

      expect(await mainIds(privateFilter), unorderedEquals(['untagged', 'travel']));
    });

    test('an include parent tag matches its children', () async {
      final privateFilter = await filter(
        CustomView(id: 'v', ownerId: me, name: 'v', includeAll: false, includeTagIds: const ['Gym']),
      );

      expect(await mainIds(privateFilter), unorderedEquals(['progress', 'travel-gym']));
    });

    test('nothing included shows nothing', () async {
      final privateFilter = await filter(CustomView(id: 'v', ownerId: me, name: 'v', includeAll: false));

      expect(await mainIds(privateFilter), isEmpty);
    });

    test('an unrestricted view changes nothing', () async {
      final privateFilter = await filter(CustomView(id: 'v', ownerId: me, name: 'v'));

      expect(privateFilter.restrictingView, isNull);
      expect(await mainIds(privateFilter), hasLength(5));
    });
  });

  group('private assets', () {
    setUp(() async {
      await asset('public');
      await asset('private', isPrivate: true);
    });

    for (final (privateAssets, locked, unlocked) in [
      (ViewPrivateAssets.hide, ['public'], ['public']),
      (ViewPrivateAssets.unlocked, ['public'], ['public', 'private']),
      (ViewPrivateAssets.only, <String>[], ['private']),
    ]) {
      test('${privateAssets.name} combines with private mode', () async {
        // an exclude rule keeps the view restricting
        await tag('Nothing');
        final view = CustomView(
          id: 'v',
          ownerId: me,
          name: 'v',
          excludeTagIds: const ['Nothing'],
          privateAssets: privateAssets,
        );

        expect(await mainIds(await filter(view)), unorderedEquals(locked));
        expect(await mainIds(await filter(view, privateMode: true)), unorderedEquals(unlocked));
      });
    }
  });

  test('other users assets pass only through include all or untagged', () async {
    final partner = (await ctx.newUser()).id;
    await tag('Travel');
    await asset('mine', tags: ['Travel']);
    await asset('partner', ownerId: partner);

    final byTag = await filter(
      CustomView(id: 'v', ownerId: me, name: 'v', includeAll: false, includeTagIds: const ['Travel']),
    );
    expect(await mainIds(byTag, userIds: [me, partner]), ['mine']);

    final untagged = await filter(
      CustomView(id: 'v', ownerId: me, name: 'v', includeAll: false, includeUntagged: true),
    );
    expect(await mainIds(untagged, userIds: [me, partner]), ['partner']);
  });

  test('local only assets show in every view', () async {
    final album = await ctx.newLocalAlbum(backupSelection: BackupSelection.selected);
    final local = await ctx.newLocalAsset(createdAt: DateTime.utc(2024, 1, 2));
    await ctx.newLocalAlbumAsset(albumId: album.id, assetId: local.id);
    await asset('remote');

    final nothing = await filter(CustomView(id: 'v', ownerId: me, name: 'v', includeAll: false));
    expect(await mainIds(nothing), [local.id]);
    expect(await mainCount(nothing), 1);
  });

  test('a stack whose primary asset is hidden is shown by its first visible member', () async {
    await tag('Hide');
    await ctx.newStack(id: 'stack', ownerId: me, primaryAssetId: 'primary');
    await asset('primary', stackId: 'stack', tags: ['Hide'], minute: 5);
    await asset('late', stackId: 'stack', minute: 9);
    await asset('early', stackId: 'stack', minute: 1);
    await asset('single');

    final noView = PrivateModeFilter(enabled: false, userId: me);
    expect(await mainIds(noView), unorderedEquals(['primary', 'single']));

    final hide = await filter(CustomView(id: 'v', ownerId: me, name: 'v', excludeTagIds: const ['Hide']));
    expect(await mainIds(hide), unorderedEquals(['early', 'single']));
    expect(await mainCount(hide), 2);

    // every member hidden: the stack is gone
    await views.addTagAssets(['Hide'], ['late', 'early']);
    expect(await mainIds(hide), ['single']);
  });

  group('albums', () {
    late PrivateModeFilter hideTravel;

    setUp(() async {
      await tag('Travel');
      await asset('visible', minute: 1);
      await asset('hidden', tags: ['Travel'], minute: 2);
      hideTravel = await filter(CustomView(id: 'v', ownerId: me, name: 'v', excludeTagIds: const ['Travel']));
    });

    test('count and cover come from the visible assets', () async {
      final album = await ctx.newRemoteAlbum(ownerId: me, thumbnailAssetId: 'hidden');
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: 'visible');
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: 'hidden');

      final unfiltered = await albums.get(album.id, privateFilter: PrivateModeFilter(enabled: false, userId: me));
      expect(unfiltered!.assetCount, 2);
      expect(unfiltered.thumbnailAssetId, 'hidden');

      final filtered = await albums.get(album.id, privateFilter: hideTravel);
      expect(filtered!.assetCount, 1);
      expect(filtered.thumbnailAssetId, 'visible');

      final buckets = await timeline.remoteAlbum(album.id, .day, privateFilter: hideTravel).bucketSource().first;
      expect(buckets.single.assetCount, 1);
      final assets = await timeline.remoteAlbum(album.id, .day, privateFilter: hideTravel).assetSource(0, 10);
      expect(assets.map((asset) => (asset as RemoteAsset).id), ['visible']);
    });

    test('an album without visible assets is hidden, an empty album stays', () async {
      final hiddenAlbum = await ctx.newRemoteAlbum(id: 'hidden-album', ownerId: me);
      await ctx.newRemoteAlbumAsset(albumId: hiddenAlbum.id, assetId: 'hidden');
      await ctx.newRemoteAlbum(id: 'empty-album', ownerId: me);
      final mixed = await ctx.newRemoteAlbum(id: 'mixed-album', ownerId: me);
      await ctx.newRemoteAlbumAsset(albumId: mixed.id, assetId: 'hidden');
      await ctx.newRemoteAlbumAsset(albumId: mixed.id, assetId: 'visible');

      final all = await albums.getAll(privateFilter: PrivateModeFilter(enabled: false, userId: me));
      expect(all.map((album) => album.id), unorderedEquals(['hidden-album', 'empty-album', 'mixed-album']));

      final filtered = await albums.getAll(privateFilter: hideTravel);
      expect(filtered.map((album) => album.id), unorderedEquals(['empty-album', 'mixed-album']));
      expect(await albums.get('hidden-album', privateFilter: hideTravel), isNull);
      expect(await albums.getCount(privateFilter: hideTravel), 2);
    });

    test('untagged motion parts of hidden live photos do not make an album visible', () async {
      // the live case: an album of tagged stills plus their hidden motion parts, which only the stills carry tags for
      for (final index in [1, 2]) {
        await ctx.newRemoteAsset(id: 'motion-$index', ownerId: me, type: .video, visibility: .hidden);
        await ctx.newRemoteAsset(id: 'still-$index', ownerId: me, livePhotoVideoId: 'motion-$index');
      }
      await views.addTagAssets(['Travel'], ['still-1', 'still-2']);
      final trip = await ctx.newRemoteAlbum(id: 'trip', ownerId: me, thumbnailAssetId: 'still-1');
      for (final assetId in ['still-1', 'motion-1', 'still-2', 'motion-2']) {
        await ctx.newRemoteAlbumAsset(albumId: trip.id, assetId: assetId);
      }
      // a visible live photo keeps its motion part
      await ctx.newRemoteAsset(id: 'motion-3', ownerId: me, type: .video, visibility: .hidden);
      await ctx.newRemoteAsset(id: 'still-3', ownerId: me, livePhotoVideoId: 'motion-3');
      final other = await ctx.newRemoteAlbum(id: 'other', ownerId: me);
      await ctx.newRemoteAlbumAsset(albumId: other.id, assetId: 'still-3');
      await ctx.newRemoteAlbumAsset(albumId: other.id, assetId: 'motion-3');

      final filtered = await albums.getAll(privateFilter: hideTravel);
      expect(filtered.map((album) => album.id), isNot(contains('trip')));
      expect(await albums.get('trip', privateFilter: hideTravel), isNull);
      final tripAssets = await timeline.remoteAlbum('trip', .day, privateFilter: hideTravel).assetSource(0, 10);
      expect(tripAssets, isEmpty);

      final otherAlbum = await albums.get('other', privateFilter: hideTravel);
      expect(otherAlbum!.assetCount, 2);

      // without a view the album and its motion parts show as before
      final unfiltered = await albums.get('trip', privateFilter: PrivateModeFilter(enabled: false, userId: me));
      expect(unfiltered!.assetCount, 4);
    });
  });

  group('repository', () {
    test('deleting a tag removes its children, links and the view rules naming them', () async {
      await tag('Gym');
      await tag('Progress', parentId: 'Gym');
      await tag('Travel');
      await asset('a', tags: ['Gym', 'Progress', 'Travel']);
      await views.replaceView(
        CustomView(id: 'v', ownerId: me, name: 'v', includeTagIds: const ['Travel'], excludeTagIds: const ['Progress']),
      );

      await views.deleteTags(['Gym']);

      expect((await views.getTags(me)).map((tag) => tag.id), ['Travel']);
      expect(await views.countTagged(['a']), {'Travel': 1});
      final view = (await views.getViews(me)).single;
      expect(view.includeTagIds, ['Travel']);
      expect(view.excludeTagIds, isEmpty);
    });

    test('a default view clears the previous default and deleting a view removes its rules', () async {
      await tag('Travel');
      await views.replaceView(CustomView(id: 'a', ownerId: me, name: 'a', isDefault: true));
      await views.replaceView(
        CustomView(id: 'b', ownerId: me, name: 'b', isDefault: true, includeTagIds: const ['Travel']),
      );

      final list = await views.getViews(me);
      expect(list.where((view) => view.isDefault).map((view) => view.id), ['b']);

      await views.deleteViews(['b']);
      expect((await views.getViews(me)).map((view) => view.id), ['a']);
      expect(await ctx.db.viewTagEntity.select().get(), isEmpty);
    });

    test('hidden tags hide their descendants', () {
      final tags = [
        TagEntry(id: 'a', ownerId: me, value: 'a', isHidden: true),
        TagEntry(id: 'b', ownerId: me, value: 'a/b', parentId: 'a'),
        TagEntry(id: 'c', ownerId: me, value: 'a/b/c', parentId: 'b'),
        TagEntry(id: 'd', ownerId: me, value: 'd'),
      ];
      expect(effectiveHiddenTagIds(tags), {'a', 'b', 'c'});
    });
  });
}
