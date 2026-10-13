import 'dart:async';
import 'dart:math' as math;

import 'package:auto_route/auto_route.dart';
import 'package:collection/collection.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/locales.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/config/app_config.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';
import 'package:immich_mobile/generated/codegen_loader.g.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline.state.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline.widget.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';

import '../../../fixtures/asset.stub.dart';

void main() {
  const assetsPerBucket = 200;
  final targetDate = DateTime(2024, 6, 15);
  final buckets = [
    TimeBucket(date: DateTime(2025, 1, 1), assetCount: assetsPerBucket),
    TimeBucket(date: targetDate, assetCount: assetsPerBucket),
    TimeBucket(date: DateTime(2024, 1, 1), assetCount: assetsPerBucket),
  ];
  final assets = List<BaseAsset>.generate(
    buckets.length * assetsPerBucket,
    (i) => LocalAssetStub.image1.copyWith(id: 'a$i'),
  );

  late StreamController<List<Bucket>> bucketController;
  late TimelineService service;

  setUp(() {
    bucketController = StreamController<List<Bucket>>.broadcast();
    service = TimelineService((
      assetSource: (i, n) async => assets.sublist(i, math.min(i + n, assets.length)),
      bucketSource: () => bucketController.stream,
      origin: TimelineOrigin.main,
    ));
  });

  tearDown(() async {
    await service.dispose();
    await bucketController.close();
  });

  Future<void> pumpTimeline(WidgetTester tester, {DateTime? initialScrollDate}) async {
    tester.view.devicePixelRatio = 3.0;
    tester.view.physicalSize = const Size(1206, 2622);
    addTearDown(tester.view.reset);

    // The timeline listens for the back button, which needs a Router above it
    final router = RootStackRouter.build(
      routes: [
        AutoRoute(
          initial: true,
          page: PageInfo(
            'Timeline',
            builder: (_) => Timeline(
              withScrubber: false,
              readOnly: true,
              groupBy: GroupAssetsBy.day,
              appBar: const SliverToBoxAdapter(child: SizedBox.shrink()),
              initialScrollDate: initialScrollDate,
            ),
          ),
        ),
      ],
    );

    // Day headers format their dates through the localization context
    await tester.pumpWidget(
      EasyLocalization(
        supportedLocales: locales.values.toList(),
        path: translationsPath,
        startLocale: locales.values.first,
        fallbackLocale: locales.values.first,
        saveLocale: false,
        useFallbackTranslations: true,
        assetLoader: const CodegenLoader(),
        child: ProviderScope(
          overrides: [
            timelineServiceProvider.overrideWithValue(service),
            appConfigProvider.overrideWithValue(const AppConfig()),
          ],
          child: Builder(
            builder: (context) => MaterialApp.router(
              localizationsDelegates: context.localizationDelegates,
              supportedLocales: context.supportedLocales,
              locale: context.locale,
              routerConfig: router.config(),
            ),
          ),
        ),
      ),
    );
    // Translations load, then the timeline shows its (endlessly animating) loading indicator
    await tester.pump();
    await tester.pump();
  }

  Future<void> emitBuckets(WidgetTester tester, List<Bucket> value) async {
    bucketController.add(value);
    // Segment stream resolves
    await tester.pump();
    // Scroll view attaches, the deferred jump runs after this frame
    await tester.pump();
    // Asset buffer settles
    await tester.pump();
    // Thumbnails will fail to load
    tester.takeException();
  }

  ScrollPosition scrollPosition(WidgetTester tester) => tester
      .state<ScrollableState>(find.descendant(of: find.byType(Timeline), matching: find.byType(Scrollable)).first)
      .position;

  double expectedOffsetFor(WidgetTester tester, DateTime date) {
    final container = ProviderScope.containerOf(tester.element(find.byType(CustomScrollView)));
    final segments = container.read(timelineSegmentProvider).requireValue;
    final segment = segments.firstWhereOrNull((segment) {
      final bucket = segment.bucket;
      return bucket is TimeBucket && bucket.date == date;
    });
    expect(segment, isNotNull, reason: 'the bucket for $date must produce a segment');
    // Same arithmetic as the "view in timeline" event: land slightly above the segment to show its header
    return (segment!.startOffset - 50).clamp(0.0, scrollPosition(tester).maxScrollExtent);
  }

  testWidgets('opens at the segment holding the initial date once the buckets arrive', (tester) async {
    await pumpTimeline(tester, initialScrollDate: targetDate);
    await emitBuckets(tester, buckets);

    final expected = expectedOffsetFor(tester, targetDate);
    expect(expected, greaterThan(0));
    expect(scrollPosition(tester).pixels, expected);
  });

  testWidgets('falls back to the month when the exact day has no segment', (tester) async {
    await pumpTimeline(tester, initialScrollDate: DateTime(2024, 6, 3));
    await emitBuckets(tester, buckets);

    expect(scrollPosition(tester).pixels, expectedOffsetFor(tester, targetDate));
  });

  testWidgets('stays at the top without an initial date', (tester) async {
    await pumpTimeline(tester);
    await emitBuckets(tester, buckets);

    expect(scrollPosition(tester).pixels, 0);
  });

  testWidgets('waits through an empty first emission instead of giving up on the date', (tester) async {
    await pumpTimeline(tester, initialScrollDate: targetDate);
    // The main timeline yields no buckets until its users resolve
    await emitBuckets(tester, const []);
    expect(find.byType(CustomScrollView), findsOneWidget);

    await emitBuckets(tester, buckets);

    expect(scrollPosition(tester).pixels, expectedOffsetFor(tester, targetDate));
  });

  testWidgets('jumps only once and leaves later bucket updates to the user', (tester) async {
    await pumpTimeline(tester, initialScrollDate: targetDate);
    await emitBuckets(tester, buckets);
    expect(scrollPosition(tester).pixels, greaterThan(0));

    scrollPosition(tester).jumpTo(0);
    await tester.pump();

    await emitBuckets(tester, [...buckets, TimeBucket(date: DateTime(2023, 1, 1), assetCount: assetsPerBucket)]);

    expect(scrollPosition(tester).pixels, 0);
  });

  testWidgets('gives up quietly when the date is not in the timeline', (tester) async {
    await pumpTimeline(tester, initialScrollDate: DateTime(1999, 1, 1));
    await emitBuckets(tester, buckets);

    expect(scrollPosition(tester).pixels, 0);
  });
}
