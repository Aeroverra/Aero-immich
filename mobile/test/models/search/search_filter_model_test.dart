import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';

void main() {
  const emptyFilter = SearchFilter(
    people: {},
    location: SearchLocationFilter(),
    camera: SearchCameraFilter(),
    date: SearchDateFilter(),
    rating: SearchRatingFilter(),
    display: SearchDisplayFilters(isNotInAlbum: false, isArchive: false, isFavorite: false),
    mediaType: AssetType.other,
  );

  group('SearchPrivateFilter', () {
    test('all maps to no isPrivate value', () {
      expect(SearchPrivateFilter.all.isPrivate, isNull);
    });

    test('onlyPrivate maps to isPrivate true', () {
      expect(SearchPrivateFilter.onlyPrivate.isPrivate, isTrue);
    });

    test('notPrivate maps to isPrivate false', () {
      expect(SearchPrivateFilter.notPrivate.isPrivate, isFalse);
    });
  });

  group('SearchFilter.private', () {
    test('defaults to all', () {
      expect(emptyFilter.private, SearchPrivateFilter.all);
      expect(emptyFilter.isEmpty, isTrue);
    });

    test('an explicit private choice makes the filter non-empty', () {
      expect(emptyFilter.copyWith(private: SearchPrivateFilter.onlyPrivate).isEmpty, isFalse);
      expect(emptyFilter.copyWith(private: SearchPrivateFilter.notPrivate).isEmpty, isFalse);
    });

    test('clearing the private choice makes the filter empty again', () {
      final cleared = emptyFilter
          .copyWith(private: SearchPrivateFilter.onlyPrivate)
          .copyWith(private: SearchPrivateFilter.all);
      expect(cleared.isEmpty, isTrue);
    });
  });
}
