import 'dart:async';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/services/search.service.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';
import 'package:immich_mobile/providers/infrastructure/search.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';

final searchPreFilterProvider = NotifierProvider<SearchFilterProvider, SearchFilter?>(SearchFilterProvider.new);

class SearchFilterProvider extends Notifier<SearchFilter?> {
  @override
  SearchFilter? build() {
    return null;
  }

  void setFilter(SearchFilter? filter) {
    state = filter;
  }

  void clear() {
    state = null;
  }
}

class SearchState {
  final List<BaseAsset> assets;
  final int? nextPage;
  final bool isLoading;

  /// Where smart search matched in the videos of [assets] that matched on a sampled frame: the position of that frame
  /// in milliseconds, by remote id
  final Map<String, int> matchedFrames;

  const SearchState({this.assets = const [], this.nextPage = 1, this.isLoading = false, this.matchedFrames = const {}});
}

/// Where smart search matched in a video of the current results, by its remote id. Null when the video matched on its
/// thumbnail or is not in the results.
final searchVideoMatchProvider = Provider.autoDispose.family<Duration?, String>((ref, remoteId) {
  final frameTimestamp = ref.watch(paginatedSearchProvider.select((state) => state.matchedFrames[remoteId]));
  return frameTimestamp == null ? null : Duration(milliseconds: frameTimestamp);
});

final paginatedSearchProvider = StateNotifierProvider<PaginatedSearchNotifier, SearchState>(
  (ref) => PaginatedSearchNotifier(
    ref.watch(searchServiceProvider),
    groupAutoStacks: () => ref.read(groupAutoStacksProvider),
  ),
);

class PaginatedSearchNotifier extends StateNotifier<SearchState> {
  final SearchService _searchService;
  final bool Function() _groupAutoStacks;
  final _assetCountController = StreamController<int>.broadcast();

  /// [groupAutoStacks] says whether automatic stacks show once too; without it they do, like the default preference
  PaginatedSearchNotifier(this._searchService, {bool Function()? groupAutoStacks})
    : _groupAutoStacks = groupAutoStacks ?? (() => true),
      super(const SearchState());

  Stream<int> get assetCount => _assetCountController.stream;

  Future<void> search(SearchFilter filter) async {
    if (state.nextPage == null || state.isLoading) {
      return;
    }

    state = SearchState(
      assets: state.assets,
      nextPage: state.nextPage,
      isLoading: true,
      matchedFrames: state.matchedFrames,
    );

    final result = await _searchService.search(
      filter,
      state.nextPage!,
      shownStackIds: {
        for (final asset in state.assets)
          if (asset case RemoteAsset(:final stackId?)) stackId,
      },
      groupAutoStacks: _groupAutoStacks(),
    );

    if (result == null) {
      state = SearchState(assets: state.assets, nextPage: state.nextPage, matchedFrames: state.matchedFrames);
      return;
    }

    final assets = [...state.assets, ...result.assets];
    state = SearchState(
      assets: assets,
      nextPage: result.nextPage,
      matchedFrames: {...state.matchedFrames, ...result.matchedFrames},
    );

    _assetCountController.add(assets.length);
  }

  void clear() {
    state = const SearchState();
    _assetCountController.add(0);
  }

  @override
  void dispose() {
    unawaited(_assetCountController.close());
    super.dispose();
  }
}
