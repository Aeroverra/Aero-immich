import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';
import 'package:immich_mobile/presentation/pages/search/paginated_search.provider.dart';
import 'package:immich_mobile/presentation/pages/search/search.page.dart';
import 'package:immich_mobile/providers/infrastructure/search.provider.dart';

/// The search results for photos similar to [assetId], pushed on top of the viewer the search was started from.
///
/// The page runs the regular search page with its own filter and result state, so it never touches the Search
/// tab: a search the viewer was opened from keeps its query and results, and back from this page returns to the
/// photo the user asked about.
@RoutePage()
class SimilarPhotosPage extends StatelessWidget {
  final String assetId;

  const SimilarPhotosPage({super.key, required this.assetId});

  @override
  Widget build(BuildContext context) {
    return ProviderScope(overrides: similarPhotosSearchOverrides(assetId), child: const SearchPage());
  }
}

/// Gives the search page opened for [assetId] a filter and results of its own instead of the Search tab's.
List<Override> similarPhotosSearchOverrides(String assetId) => [
  searchPreFilterProvider.overrideWith(() => _SimilarPhotosFilter(assetId)),
  paginatedSearchProvider.overrideWith((ref) => PaginatedSearchNotifier(ref.watch(searchServiceProvider))),
];

class _SimilarPhotosFilter extends SearchFilterProvider {
  final String assetId;

  _SimilarPhotosFilter(this.assetId);

  @override
  SearchFilter? build() => .new(
    assetId: assetId,
    people: {},
    location: const .new(),
    camera: const .new(),
    date: const .new(),
    display: const .new(isNotInAlbum: false, isArchive: false, isFavorite: false, hasNoTags: false),
    rating: const .new(),
    mediaType: .other,
  );
}
