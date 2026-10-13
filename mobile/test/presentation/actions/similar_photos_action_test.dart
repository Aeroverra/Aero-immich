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
import 'package:immich_mobile/presentation/actions/action.widget.dart';
import 'package:immich_mobile/presentation/actions/similar_photos.action.dart';
import 'package:immich_mobile/presentation/pages/search/paginated_search.provider.dart';
import 'package:immich_mobile/presentation/pages/search/search.page.dart';
import 'package:immich_mobile/presentation/pages/search/similar_photos.page.dart';
import 'package:immich_mobile/providers/asset_viewer/asset_viewer.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/readonly_mode.provider.dart';
import 'package:immich_mobile/providers/infrastructure/search.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/providers/server_info.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:mocktail/mocktail.dart';

import '../../fixtures/asset.stub.dart';
import '../../service.mocks.dart';
import '../../unit/factories/remote_asset_factory.dart';

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

/// Stands in for the page the viewer was opened from. It keeps its own state so the test can prove the page is
/// neither rebuilt nor recreated by the similar photos search.
class _OriginPage extends StatefulWidget {
  const _OriginPage();

  @override
  State<_OriginPage> createState() => _OriginPageState();
}

class _OriginPageState extends State<_OriginPage> {
  final controller = TextEditingController();

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: TextField(key: const Key('query'), controller: controller),
  );
}

class _ViewerPage extends StatelessWidget {
  final String assetId;

  const _ViewerPage({required this.assetId});

  @override
  Widget build(BuildContext context) => Scaffold(
    body: ActionMenuItem(action: SimilarPhotosAction(assetId: assetId)),
  );
}

void main() {
  const originRouteName = 'OriginRoute';
  const viewerRouteName = 'ViewerRoute';
  const searchTextField = Key('search_text_field');

  final asset = RemoteAssetFactory.create();
  final result = RemoteAssetFactory.create();
  final tabResults = SearchResult(
    assets: List<BaseAsset>.generate(8, (i) => LocalAssetStub.image1.copyWith(id: 't$i')),
  );
  final similarResults = SearchResult(
    assets: List<BaseAsset>.generate(3, (i) => LocalAssetStub.image1.copyWith(id: 's$i')),
  );

  late MockSearchService searchService;
  late ProviderContainer container;

  setUpAll(() {
    registerFallbackValue(asset);
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
    final assetService = MockAssetService();
    when(() => assetService.watchAsset(any())).thenAnswer((_) => const Stream.empty());
    searchService = MockSearchService();
    when(() => searchService.search(any(), any())).thenAnswer(
      (call) async => (call.positionalArguments.first as SearchFilter).assetId == null ? tabResults : similarResults,
    );
    container = ProviderContainer(
      overrides: [
        assetServiceProvider.overrideWithValue(assetService),
        searchServiceProvider.overrideWithValue(searchService),
        timelineFactoryProvider.overrideWithValue(_FakeTimelineFactory()),
        serverInfoProvider.overrideWith((ref) => ServerInfoNotifier(MockServerInfoService())),
        userMetadataPreferencesProvider.overrideWith((ref) async => null),
        readonlyModeProvider.overrideWith(_ReadOnlyModeOff.new),
        appConfigProvider.overrideWithValue(const AppConfig()),
      ],
    );
  });

  tearDown(() => container.dispose());

  Future<void> pumpApp(WidgetTester tester, RootStackRouter router) async {
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
        child: UncontrolledProviderScope(
          container: container,
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

  Future<void> openSimilarPhotos(WidgetTester tester) async {
    await tester.tap(find.byType(MenuItemButton));
    await tester.pumpAndSettle();
    // Thumbnails will fail to load
    tester.takeException();
  }

  /// What the phone's back button or back swipe does
  Future<void> systemBack(WidgetTester tester) async {
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    tester.takeException();
  }

  group('with a stand-in results page', () {
    late RootStackRouter router;

    setUp(() {
      router = RootStackRouter.build(
        routes: [
          AutoRoute(initial: true, page: PageInfo(originRouteName, builder: (_) => const _OriginPage())),
          AutoRoute(
            path: '/viewer',
            page: PageInfo(viewerRouteName, builder: (_) => _ViewerPage(assetId: asset.id)),
          ),
          AutoRoute(
            path: '/similar',
            page: PageInfo(
              SimilarPhotosRoute.name,
              builder: (data) => Scaffold(body: Text('similar to ${data.argsAs<SimilarPhotosRouteArgs>().assetId}')),
            ),
          ),
        ],
      );
    });

    List<String> stackNames() => router.stackData.map((data) => data.name).toList();

    Future<_OriginPageState> pumpAppWithViewerOpen(WidgetTester tester) async {
      await pumpApp(tester, router);

      await tester.enterText(find.byKey(const Key('query')), 'sunrise on the beach');
      final originState = tester.state<_OriginPageState>(find.byType(_OriginPage));

      container.read(assetViewerProvider.notifier).setAsset(asset);
      unawaited(router.pushPath('/viewer'));
      await tester.pumpAndSettle();
      expect(stackNames(), [originRouteName, viewerRouteName]);

      return originState;
    }

    testWidgets('view similar photos pushes the results above the viewer', (tester) async {
      await pumpAppWithViewerOpen(tester);

      await openSimilarPhotos(tester);

      expect(stackNames(), [originRouteName, viewerRouteName, SimilarPhotosRoute.name]);
      expect(router.stackData.last.argsAs<SimilarPhotosRouteArgs>().assetId, asset.id);
      expect(find.text('similar to ${asset.id}'), findsOneWidget);
    });

    testWidgets('back returns to the viewer and then to the page it was opened from', (tester) async {
      final originState = await pumpAppWithViewerOpen(tester);

      await openSimilarPhotos(tester);
      await systemBack(tester);

      expect(stackNames(), [originRouteName, viewerRouteName]);

      await systemBack(tester);

      expect(stackNames(), [originRouteName]);
      expect(tester.state<_OriginPageState>(find.byType(_OriginPage)), same(originState));
      expect(originState.controller.text, 'sunrise on the beach');
    });

    testWidgets('the viewer shows its own photo again after a result was opened', (tester) async {
      await pumpAppWithViewerOpen(tester);

      await openSimilarPhotos(tester);
      // Opening a result from the similar photos page reuses the shared viewer state
      container.read(assetViewerProvider.notifier)
        ..reset()
        ..setAsset(result);
      await systemBack(tester);

      expect(container.read(assetViewerProvider).currentAsset, asset);
    });

    testWidgets('the Search tab filter and results are left alone', (tester) async {
      await pumpAppWithViewerOpen(tester);
      final tabNotifier = container.read(paginatedSearchProvider.notifier);

      await openSimilarPhotos(tester);

      expect(container.read(searchPreFilterProvider), isNull);
      expect(container.read(paginatedSearchProvider.notifier), same(tabNotifier));
    });
  });

  testWidgets('the real results page searches on its own and back keeps the search it was opened from', (tester) async {
    final router = RootStackRouter.build(
      routes: [
        // The Search tab the viewer was opened from
        AutoRoute(initial: true, page: PageInfo('Search', builder: (_) => const SearchPage())),
        AutoRoute(
          path: '/viewer',
          page: PageInfo(viewerRouteName, builder: (_) => _ViewerPage(assetId: asset.id)),
        ),
        AutoRoute(path: '/similar', page: SimilarPhotosRoute.page),
      ],
    );
    await pumpApp(tester, router);

    await tester.enterText(find.byKey(searchTextField), 'sunrise on the beach');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    await tester.pump();
    await tester.pump();
    tester.takeException();
    final tabContainer = ProviderScope.containerOf(tester.element(find.byType(SearchPage)));
    expect(tabContainer.read(paginatedSearchProvider).assets, hasLength(tabResults.assets.length));

    container.read(assetViewerProvider.notifier).setAsset(asset);
    unawaited(router.pushPath('/viewer'));
    await tester.pumpAndSettle();
    await openSimilarPhotos(tester);

    expect(router.stackData.map((data) => data.name), ['Search', viewerRouteName, SimilarPhotosRoute.name]);
    final similarPage = find.byType(SearchPage).last;
    final similarContainer = ProviderScope.containerOf(tester.element(similarPage));
    expect(similarContainer.read(searchPreFilterProvider)?.assetId, asset.id);
    expect(similarContainer.read(paginatedSearchProvider).assets, hasLength(similarResults.assets.length));
    // The page is pushed, so its app bar offers a way back
    expect(find.descendant(of: similarPage, matching: find.byType(BackButton)), findsOneWidget);
    // The search underneath still holds its own query and results
    expect(tabContainer.read(paginatedSearchProvider).assets, hasLength(tabResults.assets.length));

    await systemBack(tester);
    expect(router.stackData.map((data) => data.name), ['Search', viewerRouteName]);
    expect(container.read(assetViewerProvider).currentAsset, asset);

    await systemBack(tester);
    expect(router.stackData.map((data) => data.name), ['Search']);
    final queryField = tester.widget<TextField>(
      find.descendant(of: find.byKey(searchTextField), matching: find.byType(TextField)),
    );
    expect(queryField.controller!.text, 'sunrise on the beach');
    expect(tabContainer.read(paginatedSearchProvider).assets, hasLength(tabResults.assets.length));
    // One search for the tab, one for the similar photos page, nothing fetched again on the way back
    verify(() => searchService.search(any(), any())).called(2);
  });

  test('similarPhotosSearchOverrides give the page a filter and results of its own', () {
    final page = ProviderContainer(parent: container, overrides: similarPhotosSearchOverrides('asset-1'));
    addTearDown(page.dispose);

    final filter = page.read(searchPreFilterProvider);
    expect(filter?.assetId, 'asset-1');
    expect(filter?.isEmpty, isFalse);
    expect(container.read(searchPreFilterProvider), isNull);
    expect(page.read(paginatedSearchProvider.notifier), isNot(same(container.read(paginatedSearchProvider.notifier))));
  });
}
