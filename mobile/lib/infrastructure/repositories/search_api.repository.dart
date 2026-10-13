import 'package:immich_mobile/data/server/api_repository.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart' hide AssetVisibility;
import 'package:immich_mobile/models/search/search_filter.model.dart';
import 'package:immich_mobile/utils/option.dart';
import 'package:openapi/api.dart' hide SearchFilter;

class SearchApiRepository extends ApiRepository {
  final SearchApi _api;

  const SearchApiRepository(this._api);

  Future<SearchResponseDto?> search(SearchFilter filter, int page) {
    AssetTypeEnum? type;
    if (filter.mediaType.index == AssetType.image.index) {
      type = AssetTypeEnum.IMAGE;
    } else if (filter.mediaType.index == AssetType.video.index) {
      type = AssetTypeEnum.VIDEO;
    }

    // Absent = every asset the session may see, an explicit value is only accepted while private mode is on
    final Optional<bool?> isPrivate = filter.private.isPrivate == null
        ? const Optional.absent()
        : Optional.present(filter.private.isPrivate);

    // a null tagIds asks the server for assets without any tag
    final Optional<List<String>?> tagIds = filter.display.hasNoTags
        ? const Optional.present(null)
        : filter.tagIds == null
        ? const Optional.absent()
        : Optional.present(filter.tagIds);
    // the server takes a bound or nothing, never null
    final Optional<int?> minDuration = filter.minDuration == null
        ? const Optional.absent()
        : Optional.present(filter.minDuration);
    final Optional<int?> maxDuration = filter.maxDuration == null
        ? const Optional.absent()
        : Optional.present(filter.maxDuration);
    // untagged assets carry no tag to leave out
    final Optional<List<String>?> excludeTagIds = filter.display.hasNoTags || (filter.excludeTagIds ?? []).isEmpty
        ? const Optional.absent()
        : Optional.present(filter.excludeTagIds);
    // with albums the server searches everything in them, whoever added it; assets outside every album are in none
    final Optional<List<String>?> albumIds = filter.display.isNotInAlbum || (filter.albumIds ?? []).isEmpty
        ? const Optional.absent()
        : Optional.present(filter.albumIds);
    final Optional<List<String>?> excludeAlbumIds =
        filter.display.isNotInAlbum || (filter.excludeAlbumIds ?? []).isEmpty
        ? const Optional.absent()
        : Optional.present(filter.excludeAlbumIds);
    final Optional<DateTime?> uploadedAfter = filter.uploaded.uploadedAfter == null
        ? const Optional.absent()
        : Optional.present(filter.uploaded.uploadedAfter);
    final Optional<DateTime?> uploadedBefore = filter.uploaded.uploadedBefore == null
        ? const Optional.absent()
        : Optional.present(filter.uploaded.uploadedBefore);

    if ((filter.context != null && filter.context!.isNotEmpty) ||
        (filter.assetId != null && filter.assetId!.isNotEmpty)) {
      return _api.searchSmart(
        SmartSearchDto(
          query: filter.context == null ? const Optional.absent() : Optional.present(filter.context),
          queryAssetId: filter.assetId == null ? const Optional.absent() : Optional.present(filter.assetId),
          language: filter.language == null ? const Optional.absent() : Optional.present(filter.language),
          country: filter.location.country == null
              ? const Optional.absent()
              : Optional.present(filter.location.country),
          state: filter.location.state == null ? const Optional.absent() : Optional.present(filter.location.state),
          city: filter.location.city == null ? const Optional.absent() : Optional.present(filter.location.city),
          make: filter.camera.make == null ? const Optional.absent() : Optional.present(filter.camera.make),
          model: filter.camera.model == null ? const Optional.absent() : Optional.present(filter.camera.model),
          takenAfter: filter.date.takenAfter == null
              ? const Optional.absent()
              : Optional.present(filter.date.takenAfter),
          takenBefore: filter.date.takenBefore == null
              ? const Optional.absent()
              : Optional.present(filter.date.takenBefore),
          uploadedAfter: uploadedAfter,
          uploadedBefore: uploadedBefore,
          visibility: Optional.present(filter.display.isArchive ? AssetVisibility.archive : AssetVisibility.timeline),
          rating: filter.rating.rating.toOptional(),
          isFavorite: filter.display.isFavorite ? const Optional.present(true) : const Optional.absent(),
          isNotInAlbum: filter.display.isNotInAlbum ? const Optional.present(true) : const Optional.absent(),
          isPrivate: isPrivate,
          personIds: Optional.present(filter.people.map((e) => e.id).toList()),
          tagIds: tagIds,
          excludeTagIds: excludeTagIds,
          albumIds: albumIds,
          excludeAlbumIds: excludeAlbumIds,
          minDuration: minDuration,
          maxDuration: maxDuration,
          type: type == null ? const Optional.absent() : Optional.present(type),
          page: Optional.present(page),
          size: const Optional.present(100),
        ),
      );
    }

    return _api.searchAssets(
      MetadataSearchDto(
        originalFileName: filter.filename != null && filter.filename!.isNotEmpty
            ? Optional.present(filter.filename)
            : const Optional.absent(),
        country: filter.location.country == null ? const Optional.absent() : Optional.present(filter.location.country),
        description: filter.description != null && filter.description!.isNotEmpty
            ? Optional.present(filter.description)
            : const Optional.absent(),
        ocr: filter.ocr != null && filter.ocr!.isNotEmpty ? Optional.present(filter.ocr) : const Optional.absent(),
        state: filter.location.state == null ? const Optional.absent() : Optional.present(filter.location.state),
        city: filter.location.city == null ? const Optional.absent() : Optional.present(filter.location.city),
        make: filter.camera.make == null ? const Optional.absent() : Optional.present(filter.camera.make),
        model: filter.camera.model == null ? const Optional.absent() : Optional.present(filter.camera.model),
        takenAfter: filter.date.takenAfter == null ? const Optional.absent() : Optional.present(filter.date.takenAfter),
        takenBefore: filter.date.takenBefore == null
            ? const Optional.absent()
            : Optional.present(filter.date.takenBefore),
        uploadedAfter: uploadedAfter,
        uploadedBefore: uploadedBefore,
        visibility: Optional.present(filter.display.isArchive ? AssetVisibility.archive : AssetVisibility.timeline),
        rating: filter.rating.rating.toOptional(),
        isFavorite: filter.display.isFavorite ? const Optional.present(true) : const Optional.absent(),
        isNotInAlbum: filter.display.isNotInAlbum ? const Optional.present(true) : const Optional.absent(),
        isPrivate: isPrivate,
        personIds: Optional.present(filter.people.map((e) => e.id).toList()),
        tagIds: tagIds,
        excludeTagIds: excludeTagIds,
        albumIds: albumIds,
        excludeAlbumIds: excludeAlbumIds,
        minDuration: minDuration,
        maxDuration: maxDuration,
        type: type == null ? const Optional.absent() : Optional.present(type),
        page: Optional.present(page),
        size: const Optional.present(1000),
      ),
    );
  }

  Future<List<String>?> getSearchSuggestions(
    SearchSuggestionType type, {
    String? country,
    String? state,
    String? make,
    String? model,
  }) => _api.getSearchSuggestions(type, country: country, state: state, make: make, model: model);
}
