import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/domain/models/stack.model.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';
import 'package:immich_mobile/infrastructure/repositories/custom_view.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/timeline.repository.dart';
import 'package:intl/date_symbol_data_local.dart';

import '../../utils.dart';
import '../repository_context.dart';

/// Every view shows one tile per stack like the main timeline: the primary asset, or the oldest member the view keeps
void main() {
  late MediumRepositoryContext ctx;
  late TimelineRepository sut;
  late String me;

  setUpAll(() async {
    await initializeDateFormatting();
  });

  setUp(() async {
    ctx = MediumRepositoryContext();
    sut = TimelineRepository(ctx.db);
    me = (await ctx.newUser()).id;
  });

  tearDown(() async {
    await ctx.dispose();
  });

  Future<List<String>> ids(TimelineQuery query) async {
    final assets = await query.assetSource(0, 100);
    return assets.map((asset) => (asset as RemoteAsset).id).toList();
  }

  Future<int> count(TimelineQuery query) async {
    final buckets = await query.bucketSource().first;
    return buckets.fold<int>(0, (sum, bucket) => sum + bucket.assetCount);
  }

  /// A Pixel "Video Boost" style stack: the original video as primary and the enhanced copy as a member
  Future<({String primary, String enhanced})> videoStack({
    bool primaryFavorite = true,
    bool enhancedFavorite = true,
    StackSource source = StackSource.manual,
    DateTime? deletedAt,
  }) async {
    final stackId = TestUtils.uuid();
    final primary = await ctx.newRemoteAsset(
      ownerId: me,
      type: AssetType.video,
      isFavorite: primaryFavorite,
      stackId: stackId,
      createdAt: DateTime.utc(2026, 9, 1, 12),
      deletedAt: deletedAt,
    );
    final enhanced = await ctx.newRemoteAsset(
      ownerId: me,
      type: AssetType.video,
      isFavorite: enhancedFavorite,
      stackId: stackId,
      createdAt: DateTime.utc(2026, 9, 1, 12, 1),
      deletedAt: deletedAt,
    );
    await ctx.newStack(id: stackId, ownerId: me, primaryAssetId: primary.id, source: source);
    return (primary: primary.id, enhanced: enhanced.id);
  }

  test('favorites and videos show a stack once, through its primary asset', () async {
    final stack = await videoStack();
    final single = await ctx.newRemoteAsset(ownerId: me, type: AssetType.video, isFavorite: true);

    for (final query in [sut.favorite(me, .day), sut.video(me, .day)]) {
      expect(await ids(query), unorderedEquals([stack.primary, single.id]));
      expect(await count(query), 2);
    }
  });

  test('a view that leaves out the primary shows the stack through the member it keeps', () async {
    final stack = await videoStack(primaryFavorite: false);

    expect(await ids(sut.favorite(me, .day)), [stack.enhanced]);
    expect(await count(sut.favorite(me, .day)), 1);
  });

  test('automatic stacks follow the timeline grouping toggle', () async {
    final stack = await videoStack(source: StackSource.auto);

    expect(await ids(sut.video(me, .day)), [stack.primary]);
    expect(await ids(sut.video(me, .day, groupAutoStacks: false)), unorderedEquals([stack.primary, stack.enhanced]));
    expect(await count(sut.video(me, .day, groupAutoStacks: false)), 2);
  });

  test('a manual stack stays collapsed while automatic stacks are listed separately', () async {
    final stack = await videoStack();

    expect(await ids(sut.favorite(me, .day, groupAutoStacks: false)), [stack.primary]);
  });

  test('tags show the stack through the tagged member', () async {
    final stack = await videoStack();
    final views = CustomViewRepository(ctx.db);
    await views.upsertTag(TagEntry(id: 'Boost', ownerId: me, value: 'Boost'));
    await views.addTagAssets(['Boost'], [stack.enhanced]);

    expect(await ids(sut.tagged(me, {'Boost'}, .day)), [stack.enhanced]);
  });

  test('albums show a stack once', () async {
    final stack = await videoStack();
    final album = await ctx.newRemoteAlbum(ownerId: me);
    await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: stack.primary);
    await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: stack.enhanced);

    final query = sut.remoteAlbum(album.id, .day);
    expect(await ids(query), [stack.primary]);
    expect(await count(query), 1);
  });

  test('a person shows the stack through the member with the face', () async {
    final stack = await videoStack();
    final person = await ctx.newPerson(ownerId: me);
    await ctx.newFace(assetId: stack.enhanced, personId: person.id);

    final query = sut.person(me, person.id, .day);
    expect(await ids(query), [stack.enhanced]);
    expect(await count(query), 1);
  });

  test('the trash still lists every trashed member', () async {
    final stack = await videoStack(deletedAt: DateTime.utc(2026, 9, 2));

    expect(await ids(sut.trash(me, .day)), unorderedEquals([stack.primary, stack.enhanced]));
  });
}
