import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart' as domain;
import 'package:immich_mobile/domain/services/search.service.dart';
import 'package:immich_mobile/infrastructure/repositories/search_api.repository.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart' hide SearchFilter;

class _MockSearchApiRepository extends Mock implements SearchApiRepository {}

const _filter = SearchFilter(
  people: {},
  location: SearchLocationFilter(),
  camera: SearchCameraFilter(),
  date: SearchDateFilter(),
  rating: SearchRatingFilter(),
  display: SearchDisplayFilters(isNotInAlbum: false, isArchive: false, isFavorite: false, hasNoTags: false),
  mediaType: domain.AssetType.other,
);

AssetResponseDto _asset(String id, {String? stackId, StackSource source = StackSource.manual}) => AssetResponseDto(
  checksum: 'checksum-$id',
  createdAt: DateTime(2026),
  duration: null,
  fileCreatedAt: DateTime(2026),
  fileModifiedAt: DateTime(2026),
  hasMetadata: true,
  height: 100,
  id: id,
  isArchived: false,
  isEdited: false,
  isFavorite: false,
  isOffline: false,
  isPrivate: false,
  isTrashed: false,
  localDateTime: DateTime(2026),
  originalFileName: '$id.mp4',
  originalPath: '/$id.mp4',
  ownerId: 'user-1',
  thumbhash: null,
  type: AssetTypeEnum.VIDEO,
  updatedAt: DateTime(2026),
  visibility: AssetVisibility.timeline,
  width: 100,
  stack: stackId == null
      ? const Optional.absent()
      : Optional.present(AssetStackResponseDto(assetCount: 2, id: stackId, primaryAssetId: id, source_: source)),
);

SearchResponseDto _page(List<AssetResponseDto> items, {List<SearchMatchedFrameResponseDto>? matchedFrames}) =>
    SearchResponseDto(
      albums: SearchAlbumResponseDto(count: 0, total: 0),
      assets: SearchAssetResponseDto(
        count: items.length,
        items: items,
        nextCursor: null,
        nextPage: '2',
        total: items.length,
        matchedFrames: matchedFrames == null ? const Optional.absent() : Optional.present(matchedFrames),
      ),
    );

void main() {
  late _MockSearchApiRepository api;
  late SearchService service;

  setUpAll(() => registerFallbackValue(_filter));

  setUp(() {
    api = _MockSearchApiRepository();
    service = SearchService(api);
  });

  Future<List<String>> search(
    List<AssetResponseDto> items, {
    Set<String> shown = const {},
    bool groupAuto = true,
  }) async {
    when(() => api.search(any(), any())).thenAnswer((_) async => _page(items));
    final result = await service.search(_filter, 1, shownStackIds: shown, groupAutoStacks: groupAuto);
    return result!.assets.map((asset) => (asset as domain.RemoteAsset).id).toList();
  }

  test('a stack found twice shows once, also when an earlier page showed it', () async {
    // a Video Boost pair: both files match the search
    final items = [_asset('video', stackId: 'boost'), _asset('plain'), _asset('boosted', stackId: 'boost')];

    expect(await search(items), ['video', 'plain']);
    expect(await search(items, shown: {'boost'}), ['plain']);
  });

  test('photos of an automatic stack show one by one while those are not grouped', () async {
    final items = [
      _asset('burst-1', stackId: 'burst', source: StackSource.auto),
      _asset('burst-2', stackId: 'burst', source: StackSource.auto),
      _asset('video', stackId: 'boost'),
      _asset('boosted', stackId: 'boost'),
    ];

    expect(await search(items, groupAuto: false), ['burst-1', 'burst-2', 'video']);
    expect(await search(items), ['burst-1', 'video']);
  });

  test('keeps where smart search matched in the videos that matched on a frame', () async {
    when(() => api.search(any(), any())).thenAnswer(
      (_) async => _page(
        [_asset('video'), _asset('plain')],
        matchedFrames: [SearchMatchedFrameResponseDto(assetId: 'video', frameTimestamp: 83000)],
      ),
    );

    final result = await service.search(_filter, 1);

    expect(result!.matchedFrames, {'video': 83000});
  });

  test('has no matched frames when the server does not send them', () async {
    when(() => api.search(any(), any())).thenAnswer((_) async => _page([_asset('video')]));

    final result = await service.search(_filter, 1);

    expect(result!.matchedFrames, isEmpty);
  });
}
