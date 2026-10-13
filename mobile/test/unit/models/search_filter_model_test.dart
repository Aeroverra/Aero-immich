import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart' show AssetType;
import 'package:immich_mobile/models/search/search_filter.model.dart';

SearchFilter _filter(SearchDisplayFilters display) => SearchFilter(
  people: {},
  location: const SearchLocationFilter(),
  camera: const SearchCameraFilter(),
  date: const SearchDateFilter(),
  rating: const SearchRatingFilter(),
  display: display,
  mediaType: AssetType.other,
);

void main() {
  group('SearchFilter.isEmpty', () {
    test('is empty without any display filter', () {
      const display = SearchDisplayFilters(isNotInAlbum: false, isArchive: false, isFavorite: false, hasNoTags: false);

      expect(_filter(display).isEmpty, isTrue);
    });

    test('is not empty with the not-in-album filter', () {
      const display = SearchDisplayFilters(isNotInAlbum: true, isArchive: false, isFavorite: false, hasNoTags: false);

      expect(_filter(display).isEmpty, isFalse);
    });

    test('is not empty with the no-tags filter', () {
      const display = SearchDisplayFilters(isNotInAlbum: false, isArchive: false, isFavorite: false, hasNoTags: true);

      expect(_filter(display).isEmpty, isFalse);
    });
  });
}
