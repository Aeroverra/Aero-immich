import 'package:immich_mobile/domain/models/search_result.model.dart';
import 'package:immich_mobile/extensions/asset_extensions.dart';
import 'package:immich_mobile/extensions/string_extensions.dart';
import 'package:immich_mobile/infrastructure/repositories/search_api.repository.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';
import 'package:logging/logging.dart';
import 'package:openapi/api.dart' hide AssetVisibility, SearchFilter;

class SearchService {
  final _log = Logger("SearchService");
  final SearchApiRepository _searchApiRepository;

  SearchService(this._searchApiRepository);

  Future<List<String>?> getSearchSuggestions(
    SearchSuggestionType type, {
    String? country,
    String? state,
    String? make,
    String? model,
  }) async {
    try {
      return await _searchApiRepository.getSearchSuggestions(
        type,
        country: country,
        state: state,
        make: make,
        model: model,
      );
    } catch (e) {
      _log.warning("Failed to get search suggestions", e);
    }
    return [];
  }

  /// A page of results. A stack shows once, like in the timeline: an asset is left out when [shownStackIds] or an
  /// earlier result already holds its stack, for manual stacks always and automatic ones while [groupAutoStacks].
  Future<SearchResult?> search(
    SearchFilter filter,
    int page, {
    Set<String> shownStackIds = const {},
    bool groupAutoStacks = true,
  }) async {
    try {
      final response = await _searchApiRepository.search(filter, page);

      if (response == null || response.assets.items.isEmpty) {
        return null;
      }

      final stackIds = {...shownStackIds};
      final items = response.assets.items.where((item) {
        final stack = item.stack.orElse(null);
        if (stack == null || (stack.source_ == StackSource.auto && !groupAutoStacks)) {
          return true;
        }
        return stackIds.add(stack.id);
      });

      return SearchResult(
        assets: items.map((e) => e.toDto()).toList(),
        nextPage: response.assets.nextPage?.toInt(),
        matchedFrames: {
          for (final match in response.assets.matchedFrames.orElse(null) ?? const <SearchMatchedFrameResponseDto>[])
            match.assetId: match.frameTimestamp,
        },
      );
    } catch (error, stackTrace) {
      _log.severe("Failed to search for assets", error, stackTrace);
    }
    return null;
  }
}
