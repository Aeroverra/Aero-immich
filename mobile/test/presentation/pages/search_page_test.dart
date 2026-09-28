import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/services/search.service.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';
import 'package:immich_mobile/presentation/pages/search/search.page.dart';
import 'package:immich_mobile/providers/infrastructure/search.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/server_info.provider.dart';
import 'package:mocktail/mocktail.dart';

import '../../service.mocks.dart';
import '../../test_utils.dart';
import '../../widget_tester_extensions.dart';

class _MockSearchService extends Mock implements SearchService {}

/// Flips the session state without talking to the server
class _TestPrivateModeNotifier extends PrivateModeNotifier {
  _TestPrivateModeNotifier(super.ref, {required bool enabled}) {
    state = enabled;
  }

  void set(bool enabled) => state = enabled;

  @override
  Future<void> refresh() async {}
}

void main() {
  late _MockSearchService searchService;
  late _TestPrivateModeNotifier privateMode;

  final privateChip = find.byKey(const Key('private_chip'));
  final suggestions = find.text('Search for your photos and videos');

  setUpAll(() {
    TestUtils.init();
    registerFallbackValue(
      const SearchFilter(
        people: {},
        location: SearchLocationFilter(),
        camera: SearchCameraFilter(),
        date: SearchDateFilter(),
        rating: SearchRatingFilter(),
        display: SearchDisplayFilters(isNotInAlbum: false, isArchive: false, isFavorite: false, hasNoTags: false),
        mediaType: AssetType.other,
      ),
    );
  });

  setUp(() {
    searchService = _MockSearchService();
    when(() => searchService.search(any(), any())).thenAnswer((_) async => null);
  });

  Future<void> pumpSearchPage(WidgetTester tester, {required bool privateModeEnabled}) async {
    // Wide enough that every filter chip in the horizontal list is laid out
    tester.view.physicalSize = const Size(1600, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpConsumerWidget(
      const SearchPage(),
      overrides: [
        privateModeProvider.overrideWith(
          (ref) => privateMode = _TestPrivateModeNotifier(ref, enabled: privateModeEnabled),
        ),
        serverInfoProvider.overrideWith((ref) => ServerInfoNotifier(MockServerInfoService())),
        userMetadataPreferencesProvider.overrideWith((ref) async => null),
        searchServiceProvider.overrideWithValue(searchService),
      ],
    );
  }

  testWidgets('private chip is absent while private mode is off', (tester) async {
    await pumpSearchPage(tester, privateModeEnabled: false);

    expect(find.byKey(const Key('media_type_chip')), findsOneWidget);
    expect(privateChip, findsNothing);
  });

  testWidgets('private chip shows while private mode is on', (tester) async {
    await pumpSearchPage(tester, privateModeEnabled: true);

    expect(privateChip, findsOneWidget);
    expect(find.descendant(of: privateChip, matching: find.text('Private')), findsOneWidget);
  });

  testWidgets('turning private mode off clears the private filter and searches again', (tester) async {
    await pumpSearchPage(tester, privateModeEnabled: true);

    await tester.tap(privateChip);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('private_only')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('search_filter_apply')));
    await tester.pumpAndSettle();

    final sent = verify(() => searchService.search(captureAny(), 1)).captured.single as SearchFilter;
    expect(sent.private, SearchPrivateFilter.onlyPrivate);
    expect(find.descendant(of: privateChip, matching: find.text('Only private')), findsOneWidget);
    expect(suggestions, findsNothing);

    privateMode.set(false);
    await tester.pumpAndSettle();

    // The filter is empty again, so the page is back to its suggestions instead of stale private results
    expect(privateChip, findsNothing);
    expect(suggestions, findsOneWidget);
    verifyNever(() => searchService.search(any(), any()));

    privateMode.set(true);
    await tester.pumpAndSettle();

    expect(privateChip, findsOneWidget);
    expect(find.descendant(of: privateChip, matching: find.text('Private')), findsOneWidget);
    expect(find.descendant(of: privateChip, matching: find.text('Only private')), findsNothing);
  });
}
