import 'package:freezed_annotation/freezed_annotation.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';

part 'search_result.model.freezed.dart';

@Freezed(toStringOverride: false)
abstract class SearchResult with _$SearchResult {
  const SearchResult._();

  /// [matchedFrames] says where smart search matched in the videos that matched on a sampled frame rather than their
  /// thumbnail: the position of that frame in milliseconds, by the remote id of the video.
  const factory SearchResult({
    required List<BaseAsset> assets,
    int? nextPage,
    @Default({}) Map<String, int> matchedFrames,
  }) = _SearchResult;

  // Explicitly don't log results, only attributes
  @override
  String toString() => 'SearchResult(assets: ${assets.length}, nextPage: $nextPage)';
}
