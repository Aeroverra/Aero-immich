import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/locales.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/config/app_config.dart';
import 'package:immich_mobile/domain/models/search_result.model.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';
import 'package:immich_mobile/domain/services/search.service.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';
import 'package:immich_mobile/generated/codegen_loader.g.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';
import 'package:immich_mobile/presentation/pages/search/paginated_search.provider.dart';
import 'package:immich_mobile/presentation/pages/search/search.page.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline.widget.dart';
import 'package:immich_mobile/providers/infrastructure/readonly_mode.provider.dart';
import 'package:immich_mobile/providers/infrastructure/search.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/providers/server_info.provider.dart';
import 'package:mocktail/mocktail.dart';

import '../../../fixtures/asset.stub.dart';
import '../../../service.mocks.dart';

class MockSearchService extends Mock implements SearchService {}

/// Builds the search-backed timeline service the way the drift repository does, without a database.
class _FakeTimelineFactory extends Fake implements TimelineFactory {
  @override
  TimelineService fromAssetStream(List<BaseAsset> Function() getAssets, Stream<int> assetCount, TimelineOrigin type) {
    return TimelineService((
      bucketSource: () async* {
        yield [Bucket(assetCount: getAssets().length)];
        yield* assetCount.map((count) => [Bucket(assetCount: count)]);
      },
      assetSource: (offset, count) async => getAssets().skip(offset).take(count).toList(growable: false),
      origin: type,
    ));
  }
}

class _ReadOnlyModeOff extends ReadOnlyModeNotifier {
  @override
  bool build() => false;
}

void main() {
  const searchTextField = Key('search_text_field');
  final results = SearchResult(assets: List<BaseAsset>.generate(80, (i) => LocalAssetStub.image1.copyWith(id: 'a$i')));

  late MockSearchService searchService;
  late RootStackRouter router;

  setUpAll(() {
    registerFallbackValue(
      const SearchFilter(
        people: {},
        location: SearchLocationFilter(),
        camera: SearchCameraFilter(),
        date: SearchDateFilter(),
        display: SearchDisplayFilters(isNotInAlbum: false, isArchive: false, isFavorite: false, hasNoTags: false),
        rating: SearchRatingFilter(),
        mediaType: AssetType.other,
      ),
    );
  });

  setUp(() {
    searchService = MockSearchService();
    when(() => searchService.search(any(), any())).thenAnswer((_) async => results);

    router = RootStackRouter.build(
      routes: [
        AutoRoute(initial: true, page: PageInfo('Search', builder: (_) => const SearchPage())),
        AutoRoute(
          path: '/timeline',
          page: PageInfo('Timeline', builder: (_) => const Scaffold(body: Text('pushed timeline'))),
        ),
      ],
    );
  });

  Future<void> pumpSearchPage(WidgetTester tester) async {
    tester.view.devicePixelRatio = 3.0;
    tester.view.physicalSize = const Size(1206, 2622);
    addTearDown(tester.view.reset);

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
            searchServiceProvider.overrideWithValue(searchService),
            timelineFactoryProvider.overrideWithValue(_FakeTimelineFactory()),
            serverInfoProvider.overrideWith((ref) => ServerInfoNotifier(MockServerInfoService())),
            userMetadataPreferencesProvider.overrideWith((ref) async => null),
            readonlyModeProvider.overrideWith(_ReadOnlyModeOff.new),
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
    await tester.pumpAndSettle();
  }

  Future<void> submitQuery(WidgetTester tester, String query) async {
    await tester.enterText(find.byKey(searchTextField), query);
    await tester.testTextInput.receiveAction(TextInputAction.done);
    // Search resolves
    await tester.pump();
    // Segment stream resolves and the grid attaches
    await tester.pump();
    // Asset buffer settles
    await tester.pump();
    // Thumbnails will fail to load
    tester.takeException();
  }

  String queryText(WidgetTester tester) => tester
      .widget<TextField>(find.descendant(of: find.byKey(searchTextField), matching: find.byType(TextField)))
      .controller!
      .text;

  ScrollPosition gridPosition(WidgetTester tester) => tester
      .state<ScrollableState>(find.descendant(of: find.byType(Timeline), matching: find.byType(Scrollable)).first)
      .position;

  ProviderContainer container(WidgetTester tester) =>
      ProviderScope.containerOf(tester.element(find.byType(SearchPage)));

  testWidgets('the search page keeps its query, results and scroll offset across a pushed route', (tester) async {
    await pumpSearchPage(tester);
    await submitQuery(tester, 'sunrise on the beach');

    expect(find.byType(Timeline), findsOneWidget);
    expect(container(tester).read(paginatedSearchProvider).assets, hasLength(results.assets.length));

    await tester.drag(find.byType(Timeline), const Offset(0, -900));
    await tester.pumpAndSettle();
    tester.takeException();
    final scrolledOffset = gridPosition(tester).pixels;
    expect(scrolledOffset, greaterThan(0));

    // The same thing "view in timeline" does now: a route above the tab shell, never a tab switch
    unawaited(router.pushPath('/timeline'));
    await tester.pumpAndSettle();
    expect(find.text('pushed timeline'), findsOneWidget);

    await router.maybePop();
    await tester.pumpAndSettle();
    tester.takeException();

    expect(find.byType(SearchPage), findsOneWidget);
    expect(queryText(tester), 'sunrise on the beach');
    expect(find.byType(Timeline), findsOneWidget);
    expect(container(tester).read(paginatedSearchProvider).assets, hasLength(results.assets.length));
    expect(gridPosition(tester).pixels, scrolledOffset);
    // Nothing was fetched again on the way back
    verify(() => searchService.search(any(), any())).called(1);
  });
}
