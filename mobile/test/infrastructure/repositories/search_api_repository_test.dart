import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/infrastructure/repositories/search_api.repository.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart' hide SearchFilter;

class _MockSearchApi extends Mock implements SearchApi {}

void main() {
  late _MockSearchApi api;
  late SearchApiRepository repo;

  const filter = SearchFilter(
    people: {},
    location: SearchLocationFilter(),
    camera: SearchCameraFilter(),
    date: SearchDateFilter(),
    rating: SearchRatingFilter(),
    display: SearchDisplayFilters(isNotInAlbum: false, isArchive: false, isFavorite: false, hasNoTags: false),
    mediaType: AssetType.other,
  );

  setUpAll(() {
    registerFallbackValue(MetadataSearchDto());
    registerFallbackValue(SmartSearchDto());
  });

  setUp(() {
    api = _MockSearchApi();
    repo = SearchApiRepository(api);
    when(
      () => api.searchAssets(
        any(),
        key: any(named: 'key'),
        slug: any(named: 'slug'),
        abortTrigger: any(named: 'abortTrigger'),
      ),
    ).thenAnswer((_) async => null);
    when(() => api.searchSmart(any(), abortTrigger: any(named: 'abortTrigger'))).thenAnswer((_) async => null);
  });

  MetadataSearchDto sentMetadata() => verify(
    () => api.searchAssets(
      captureAny(),
      key: any(named: 'key'),
      slug: any(named: 'slug'),
      abortTrigger: any(named: 'abortTrigger'),
    ),
  ).captured.single;

  SmartSearchDto sentSmart() =>
      verify(() => api.searchSmart(captureAny(), abortTrigger: any(named: 'abortTrigger'))).captured.single;

  group('metadata search', () {
    test('omits isPrivate when the private filter is all', () async {
      await repo.search(filter, 1);

      expect(sentMetadata().isPrivate.isPresent, isFalse);
    });

    test('sends isPrivate true for only private', () async {
      await repo.search(filter.copyWith(private: SearchPrivateFilter.onlyPrivate), 1);

      expect(sentMetadata().isPrivate, const Optional<bool?>.present(true));
    });

    test('sends isPrivate false for not private', () async {
      await repo.search(filter.copyWith(private: SearchPrivateFilter.notPrivate), 1);

      expect(sentMetadata().isPrivate, const Optional<bool?>.present(false));
    });
  });

  group('smart search', () {
    final smartFilter = filter.copyWith(context: 'sunset');

    test('omits isPrivate when the private filter is all', () async {
      await repo.search(smartFilter, 1);

      expect(sentSmart().isPrivate.isPresent, isFalse);
    });

    test('sends isPrivate true for only private', () async {
      await repo.search(smartFilter.copyWith(private: SearchPrivateFilter.onlyPrivate), 1);

      expect(sentSmart().isPrivate, const Optional<bool?>.present(true));
    });

    test('sends isPrivate false for not private', () async {
      await repo.search(smartFilter.copyWith(private: SearchPrivateFilter.notPrivate), 1);

      expect(sentSmart().isPrivate, const Optional<bool?>.present(false));
    });
  });
}
