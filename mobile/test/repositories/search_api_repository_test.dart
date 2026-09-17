import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart' show AssetType;
import 'package:immich_mobile/infrastructure/repositories/search_api.repository.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart' hide SearchFilter;

class _MockSearchApi extends Mock implements SearchApi {}

const _noDisplayFilters = SearchDisplayFilters(
  isNotInAlbum: false,
  isArchive: false,
  isFavorite: false,
  hasNoTags: false,
);

SearchFilter _filter({SearchDisplayFilters display = _noDisplayFilters, List<String>? tagIds, String? context}) =>
    SearchFilter(
      context: context,
      tagIds: tagIds,
      people: {},
      location: const SearchLocationFilter(),
      camera: const SearchCameraFilter(),
      date: const SearchDateFilter(),
      rating: const SearchRatingFilter(),
      display: display,
      mediaType: AssetType.other,
    );

void main() {
  late _MockSearchApi api;
  late SearchApiRepository repo;

  setUpAll(() {
    registerFallbackValue(MetadataSearchDto());
    registerFallbackValue(SmartSearchDto());
  });

  setUp(() {
    api = _MockSearchApi();
    repo = SearchApiRepository(api);
    when(() => api.searchAssets(any())).thenAnswer((_) async => null);
    when(() => api.searchSmart(any())).thenAnswer((_) async => null);
  });

  MetadataSearchDto capturedMetadata() => verify(() => api.searchAssets(captureAny())).captured.single;

  SmartSearchDto capturedSmart() => verify(() => api.searchSmart(captureAny())).captured.single;

  group('tag filters', () {
    test('selected tags are sent as tagIds', () async {
      await repo.search(_filter(tagIds: ['tag-1', 'tag-2']), 1);

      expect(capturedMetadata().tagIds.value, ['tag-1', 'tag-2']);
    });

    test('no tags is sent as a null tagIds', () async {
      const display = SearchDisplayFilters(isNotInAlbum: false, isArchive: false, isFavorite: false, hasNoTags: true);

      await repo.search(_filter(display: display, tagIds: ['tag-1']), 1);

      final dto = capturedMetadata();
      expect(dto.tagIds.isPresent, isTrue);
      expect(dto.tagIds.value, isNull);
    });

    test('no tags is sent as a null tagIds for smart search', () async {
      const display = SearchDisplayFilters(isNotInAlbum: false, isArchive: false, isFavorite: false, hasNoTags: true);

      await repo.search(_filter(display: display, context: 'beach'), 1);

      final dto = capturedSmart();
      expect(dto.tagIds.isPresent, isTrue);
      expect(dto.tagIds.value, isNull);
    });
  });

  group('album filter', () {
    test('not in album is only sent when set', () async {
      await repo.search(_filter(), 1);
      expect(capturedMetadata().isNotInAlbum.isPresent, isFalse);

      const display = SearchDisplayFilters(isNotInAlbum: true, isArchive: false, isFavorite: false, hasNoTags: false);
      await repo.search(_filter(display: display), 1);
      expect(capturedMetadata().isNotInAlbum.value, isTrue);
    });

    test('not in album and no tags combine with the other display filters', () async {
      const display = SearchDisplayFilters(isNotInAlbum: true, isArchive: false, isFavorite: true, hasNoTags: true);

      await repo.search(_filter(display: display, context: 'beach'), 1);

      final dto = capturedSmart();
      expect(dto.isNotInAlbum.value, isTrue);
      expect(dto.isFavorite.value, isTrue);
      expect(dto.tagIds.value, isNull);
      expect(dto.visibility.value, AssetVisibility.timeline);
    });
  });
}
