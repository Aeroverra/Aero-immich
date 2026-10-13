import 'dart:math' as math;

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/config/app_config.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';
import 'package:immich_mobile/presentation/widgets/images/thumbnail_tile.widget.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline.widget.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';

import '../../../fixtures/asset.stub.dart';

const _appBarHeight = 56.0;

// local assets, remote thumbnails need the store
LocalAsset _asset(String id, DateTime createdAt) =>
    LocalAssetStub.image1.copyWith(id: id, name: '$id.jpg', createdAt: createdAt, updatedAt: createdAt);

List<TimeBucket> _buckets(List<BaseAsset> assets) {
  final buckets = <TimeBucket>[];
  for (final asset in assets) {
    final day = DateTime(asset.createdAt.year, asset.createdAt.month, asset.createdAt.day);
    if (buckets.isNotEmpty && buckets.last.date == day) {
      buckets[buckets.length - 1] = TimeBucket(date: day, assetCount: buckets.last.assetCount + 1);
    } else {
      buckets.add(TimeBucket(date: day, assetCount: 1));
    }
  }
  return buckets;
}

/// Stands in for a filter the timeline service is rebuilt on, such as private mode or automatic stack grouping
final _hideSomeProvider = StateProvider<bool>((_) => false);

void main() {
  testWidgets('keeps the top visible photo in place when the timeline service is rebuilt with other assets', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 3.0;
    tester.view.physicalSize = const Size(1206, 2622);
    addTearDown(tester.view.reset);

    final all = [
      for (int day = 30; day >= 1; day--)
        for (int i = 0; i < 40; i++) _asset('d$day-$i', DateTime(2024, 1, day, 20).subtract(Duration(minutes: i))),
    ];
    // every third photo disappears when the filter is on
    final filtered = [
      for (int i = 0; i < all.length; i++)
        if (i % 3 != 1) all[i],
    ];

    final router = RootStackRouter.build(
      routes: [
        AutoRoute(
          initial: true,
          page: PageInfo(
            'Timeline',
            builder: (_) => const Timeline(
              withScrubber: false,
              readOnly: true,
              groupBy: GroupAssetsBy.none,
              appBar: SliverToBoxAdapter(child: SizedBox(height: _appBarHeight)),
            ),
          ),
        ),
      ],
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          appConfigProvider.overrideWithValue(const AppConfig()),
          timelineServiceProvider.overrideWith((ref) {
            final assets = ref.watch(_hideSomeProvider) ? filtered : all;
            final service = TimelineService((
              assetSource: (index, count) async =>
                  assets.sublist(math.min(index, assets.length), math.min(index + count, assets.length)),
              bucketSource: () => Stream.value(_buckets(assets)),
              origin: TimelineOrigin.main,
            ));
            ref.onDispose(service.dispose);
            return service;
          }),
        ],
        child: MaterialApp.router(routerConfig: router.config()),
      ),
    );
    await _settle(tester);

    final scrollable = find.descendant(of: find.byType(Timeline), matching: find.byType(Scrollable)).first;
    ScrollPosition position() => tester.state<ScrollableState>(scrollable).position;
    final viewportTop = tester.getRect(scrollable).top;

    // scroll deep into the timeline with part of a row scrolled past the top, onto a photo the filter keeps
    var before = (id: '', top: 0.0);
    for (double offset = 15000; !filtered.any((asset) => asset.id == before.id); offset += 37) {
      position().jumpTo(offset);
      await _settle(tester);
      before = _topTile(tester, viewportTop);
    }
    final pixelsBefore = position().pixels;
    expect(before.top, lessThan(viewportTop), reason: 'the top row is partly scrolled past');

    final container = ProviderScope.containerOf(tester.element(find.byType(Timeline)));
    container.read(_hideSomeProvider.notifier).state = true;
    await _settle(tester);

    final filteredTile = _tile(tester, before.id);
    expect(filteredTile, isNotNull, reason: 'the same photo is on screen');
    expect(filteredTile!.top, closeTo(before.top, 0.5), reason: 'at the same distance from the viewport top');
    expect(position().pixels, lessThan(pixelsBefore - 1000), reason: 'a third of the photos above are gone');

    container.read(_hideSomeProvider.notifier).state = false;
    await _settle(tester);

    final restoredTile = _tile(tester, before.id);
    expect(restoredTile, isNotNull);
    expect(restoredTile!.top, closeTo(before.top, 0.5));
    expect(position().pixels, closeTo(pixelsBefore, 0.5));
  });
}

Future<void> _settle(WidgetTester tester) async {
  for (int i = 0; i < 20; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
  // remote thumbnails cannot load in tests
  while (tester.takeException() != null) {}
}

({String id, double top}) _topTile(WidgetTester tester, double viewportTop) {
  final tiles = tester
      .widgetList<ThumbnailTile>(find.byType(ThumbnailTile))
      .map((tile) {
        final rect = tester.getRect(find.byWidget(tile));
        return (id: tile.asset!.id, top: rect.top, left: rect.left, bottom: rect.bottom);
      })
      .where((tile) => tile.bottom > viewportTop);
  final top = tiles.reduce((a, b) => a.top < b.top || (a.top == b.top && a.left < b.left) ? a : b);
  return (id: top.id, top: top.top);
}

({String id, double top})? _tile(WidgetTester tester, String id) {
  for (final tile in tester.widgetList<ThumbnailTile>(find.byType(ThumbnailTile))) {
    if (tile.asset?.id == id) {
      return (id: id, top: tester.getRect(find.byWidget(tile)).top);
    }
  }
  return null;
}
