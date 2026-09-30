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

  group('excluded tags', () {
    test('sends excluded tags next to the included ones, for both searches', () async {
      final tagged = filter.copyWith(tagIds: ['work'], excludeTagIds: ['holiday']);

      await repo.search(tagged, 1);
      await repo.search(tagged.copyWith(context: 'sunset'), 1);

      expect(sentMetadata().excludeTagIds.value, ['holiday']);
      expect(sentSmart().excludeTagIds.value, ['holiday']);
    });

    test('omits excluded tags when there are none or the search is for untagged assets', () async {
      await repo.search(filter.copyWith(excludeTagIds: []), 1);
      expect(sentMetadata().excludeTagIds.isPresent, isFalse);

      final untagged = filter.copyWith(excludeTagIds: ['holiday'], display: filter.display.copyWith(hasNoTags: true));
      await repo.search(untagged, 1);
      expect(sentMetadata().excludeTagIds.isPresent, isFalse);
    });
  });

  group('video length', () {
    test('sends the bounds that are set and leaves the others out', () async {
      await repo.search(filter.copyWith(minDuration: 30000), 1);
      await repo.search(filter.copyWith(context: 'sunset', minDuration: 30000, maxDuration: 300000), 1);

      final metadata = sentMetadata();
      expect(metadata.minDuration, const Optional<int?>.present(30000));
      expect(metadata.maxDuration.isPresent, isFalse);
      final smart = sentSmart();
      expect(smart.minDuration, const Optional<int?>.present(30000));
      expect(smart.maxDuration, const Optional<int?>.present(300000));
    });
  });

  group('albums', () {
    test('sends the albums to search in and the ones to leave out, for both searches', () async {
      final albums = filter.copyWith(albumIds: ['trip'], excludeAlbumIds: ['work', 'receipts']);

      await repo.search(albums, 1);
      await repo.search(albums.copyWith(context: 'sunset'), 1);

      final metadata = sentMetadata();
      expect(metadata.albumIds.value, ['trip']);
      expect(metadata.excludeAlbumIds.value, ['work', 'receipts']);
      final smart = sentSmart();
      expect(smart.albumIds.value, ['trip']);
      expect(smart.excludeAlbumIds.value, ['work', 'receipts']);
    });

    test('leaves both out when no album is picked, never sending null', () async {
      await repo.search(filter.copyWith(albumIds: [], excludeAlbumIds: []), 1);
      await repo.search(filter.copyWith(context: 'sunset'), 1);

      final metadata = sentMetadata();
      expect(metadata.albumIds.isPresent, isFalse);
      expect(metadata.excludeAlbumIds.isPresent, isFalse);
      final smart = sentSmart();
      expect(smart.albumIds.isPresent, isFalse);
      expect(smart.excludeAlbumIds.isPresent, isFalse);
    });

    test('leaves the albums out while searching for assets outside every album', () async {
      final notInAlbum = filter.copyWith(
        albumIds: ['trip'],
        excludeAlbumIds: ['work'],
        display: filter.display.copyWith(isNotInAlbum: true),
      );

      await repo.search(notInAlbum, 1);

      final metadata = sentMetadata();
      expect(metadata.isNotInAlbum, const Optional<bool?>.present(true));
      expect(metadata.albumIds.isPresent, isFalse);
      expect(metadata.excludeAlbumIds.isPresent, isFalse);
    });
  });

  group('upload date', () {
    final after = DateTime(2024, 3, 1);
    final before = DateTime(2024, 3, 31, 23, 59, 59, 999);

    test('sends the upload date bounds next to the taken date, for both searches', () async {
      final uploaded = filter.copyWith(
        date: SearchDateFilter(takenAfter: DateTime(2020)),
        uploaded: SearchUploadDateFilter(uploadedAfter: after, uploadedBefore: before),
      );

      await repo.search(uploaded, 1);
      await repo.search(uploaded.copyWith(context: 'sunset'), 1);

      final metadata = sentMetadata();
      expect(metadata.uploadedAfter.value, after);
      expect(metadata.uploadedBefore.value, before);
      expect(metadata.takenAfter.value, DateTime(2020));
      final smart = sentSmart();
      expect(smart.uploadedAfter.value, after);
      expect(smart.uploadedBefore.value, before);
    });

    test('sends only the bound that is set', () async {
      await repo.search(filter.copyWith(uploaded: SearchUploadDateFilter(uploadedAfter: after)), 1);

      final metadata = sentMetadata();
      expect(metadata.uploadedAfter.value, after);
      expect(metadata.uploadedBefore.isPresent, isFalse);
    });

    test('leaves the upload date out when it is not set', () async {
      await repo.search(filter, 1);
      await repo.search(filter.copyWith(context: 'sunset'), 1);

      final metadata = sentMetadata();
      expect(metadata.uploadedAfter.isPresent, isFalse);
      expect(metadata.uploadedBefore.isPresent, isFalse);
      final smart = sentSmart();
      expect(smart.uploadedAfter.isPresent, isFalse);
      expect(smart.uploadedBefore.isPresent, isFalse);
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
