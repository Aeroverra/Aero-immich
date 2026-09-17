import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/api_repository.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:openapi/api.dart';

final tagsApiRepositoryProvider = Provider<TagsApiRepository>(
  (ref) => TagsApiRepository(ref.read(apiServiceProvider).tagsApi),
);

class TagsApiRepository extends ApiRepository {
  final TagsApi _api;
  const TagsApiRepository(this._api);

  Future<List<TagResponseDto>?> getAllTags() async {
    return await _api.getAllTags();
  }

  Future<int> bulkTagAssets(List<String> assetIds, List<String> tagIds) async {
    final response = await _api.bulkTagAssets(TagBulkAssetsDto(assetIds: assetIds, tagIds: tagIds));
    return response?.count ?? 0;
  }

  Future<List<TagResponseDto>?> upsertTags(List<String> tags) async {
    return _api.upsertTags(TagUpsertDto(tags: tags));
  }

  /// Creates the tag [name] below [parentId]
  Future<TagResponseDto> createTag(String name, {String? parentId, bool? isHidden}) {
    return checkNull(
      _api.createTag(
        TagCreateDto(
          name: name,
          parentId: parentId == null ? const Optional.absent() : Optional.present(parentId),
          isHidden: isHidden == null ? const Optional.absent() : Optional.present(isHidden),
        ),
      ),
    );
  }

  Future<TagResponseDto> updateTag(String id, {bool? isHidden, String? color}) {
    return checkNull(
      _api.updateTag(
        id,
        TagUpdateDto(
          isHidden: isHidden == null ? const Optional.absent() : Optional.present(isHidden),
          color: color == null ? const Optional.absent() : Optional.present(color),
        ),
      ),
    );
  }

  Future<void> deleteTag(String id) => _api.deleteTag(id);

  /// Ids of [assetIds] the tag was added to
  Future<List<String>> tagAssets(String tagId, List<String> assetIds) async {
    final results = await _api.tagAssets(tagId, BulkIdsDto(ids: assetIds));
    return [
      for (final result in results ?? const <BulkIdResponseDto>[])
        if (result.success) result.id,
    ];
  }

  /// Ids of [assetIds] the tag was removed from
  Future<List<String>> untagAssets(String tagId, List<String> assetIds) async {
    final results = await _api.untagAssets(tagId, BulkIdsDto(ids: assetIds));
    return [
      for (final result in results ?? const <BulkIdResponseDto>[])
        if (result.success) result.id,
    ];
  }
}
