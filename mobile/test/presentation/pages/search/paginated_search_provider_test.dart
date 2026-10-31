import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/search_result.model.dart';
import 'package:immich_mobile/domain/services/search.service.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';
import 'package:immich_mobile/presentation/pages/search/paginated_search.provider.dart';
import 'package:immich_mobile/providers/infrastructure/search.provider.dart';
import 'package:mocktail/mocktail.dart';

class _MockSearchService extends Mock implements SearchService {}

const _filter = SearchFilter(
  context: 'dog',
  people: {},
  location: SearchLocationFilter(),
  camera: SearchCameraFilter(),
  date: SearchDateFilter(),
  rating: SearchRatingFilter(),
  display: SearchDisplayFilters(isNotInAlbum: false, isArchive: false, isFavorite: false, hasNoTags: false),
  mediaType: AssetType.other,
);

void main() {
  late _MockSearchService service;
  late ProviderContainer container;

  setUpAll(() => registerFallbackValue(_filter));

  setUp(() {
    service = _MockSearchService();
    container = ProviderContainer(overrides: [searchServiceProvider.overrideWithValue(service)]);
    addTearDown(container.dispose);
  });

  void answerPages(List<SearchResult> pages) {
    var page = 0;
    when(
      () => service.search(
        any(),
        any(),
        shownStackIds: any(named: 'shownStackIds'),
        groupAutoStacks: any(named: 'groupAutoStacks'),
      ),
    ).thenAnswer((_) async => pages[page++]);
  }

  test('keeps where videos matched across pages and forgets it on clear', () async {
    answerPages(const [
      SearchResult(assets: [], nextPage: 2, matchedFrames: {'video-1': 83000}),
      SearchResult(assets: [], nextPage: 3, matchedFrames: {'video-2': 1500}),
    ]);
    final notifier = container.read(paginatedSearchProvider.notifier);

    await notifier.search(_filter);
    await notifier.search(_filter);

    expect(container.read(searchVideoMatchProvider('video-1')), const Duration(seconds: 83));
    expect(container.read(searchVideoMatchProvider('video-2')), const Duration(milliseconds: 1500));
    expect(container.read(searchVideoMatchProvider('photo')), isNull);

    notifier.clear();

    expect(container.read(searchVideoMatchProvider('video-1')), isNull);
  });
}
