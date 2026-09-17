import 'dart:convert';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/custom_view.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/tags_api.repository.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/tag.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/repositories/custom_view_api.repository.dart';
import 'package:openapi/api.dart' show TagResponseDto;

/// How many recently used tags the tag sheet offers
const kRecentTagCount = 8;

/// A tag in a tree listing with its depth below the root
typedef TagTreeEntry = ({TagEntry tag, int depth});

/// [tags] ordered as a tree (every parent directly before its children, siblings by name) with their depth. Tags whose
/// parent is not in [tags] are listed as roots.
List<TagTreeEntry> buildTagTree(Iterable<TagEntry> tags) {
  final byId = {for (final tag in tags) tag.id: tag};
  final children = <String?, List<TagEntry>>{};
  for (final tag in tags) {
    final parentId = byId.containsKey(tag.parentId) ? tag.parentId : null;
    children.putIfAbsent(parentId, () => []).add(tag);
  }
  for (final list in children.values) {
    list.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
  }

  final result = <TagTreeEntry>[];
  final visited = <String>{};
  void visit(String? parentId, int depth) {
    for (final tag in children[parentId] ?? const <TagEntry>[]) {
      if (visited.add(tag.id)) {
        result.add((tag: tag, depth: depth));
        visit(tag.id, depth + 1);
      }
    }
  }

  visit(null, 0);
  return result;
}

/// The visible tags of the user as a tree
final tagTreeProvider = Provider<List<TagTreeEntry>>((ref) => buildTagTree(ref.watch(visibleTagsProvider)));

/// Tags of an asset the user may see now (hidden tags only while private mode is unlocked)
final assetTagsProvider = StreamProvider.autoDispose.family<List<TagEntry>, String>((ref, assetId) {
  final hidden = ref.watch(lockedHiddenTagIdsProvider);
  return ref
      .watch(driftProvider)
      .customViewRepository
      .watchAssetTags(assetId)
      .map((tags) => tags.where((tag) => !hidden.contains(tag.id)).toList());
});

final taggingServiceProvider = Provider<TaggingService>(
  (ref) => TaggingService(
    api: ref.watch(tagsApiRepositoryProvider),
    viewApi: ref.watch(customViewApiRepositoryProvider),
    repository: ref.watch(driftProvider).customViewRepository,
    ownerId: () => ref.read(currentUserProvider)?.id ?? '',
    onTagsChanged: () => ref.invalidate(tagProvider),
  ),
);

/// Adds, removes, creates, hides and deletes tags on the server and mirrors every change in the local tables right
/// away, so the app follows before the next sync delivers the same rows
class TaggingService {
  final TagsApiRepository _api;
  final CustomViewApiRepository _viewApi;
  final CustomViewRepository _repository;
  final String Function() _ownerId;
  final void Function() _onTagsChanged;

  const TaggingService({
    required this._api,
    required this._viewApi,
    required this._repository,
    required this._ownerId,
    required this._onTagsChanged,
  });

  /// Creates the tag [path] ("Parent/Child" creates the missing parents too) and returns the tag at the end of it
  Future<TagEntry> createTag(String path) async {
    final value = path.split('/').map((part) => part.trim()).where((part) => part.isNotEmpty).join('/');
    final dtos = await _api.upsertTags([value]);
    final tags = (dtos ?? const <TagResponseDto>[]).map(_toEntry).toList();
    for (final tag in tags) {
      await _repository.upsertTag(tag);
    }
    _onTagsChanged();
    return tags.firstWhere((tag) => tag.value == value, orElse: () => tags.last);
  }

  Future<void> addTag(String tagId, List<String> assetIds) async {
    if (assetIds.isEmpty) {
      return;
    }
    await _api.tagAssets(tagId, assetIds);
    await _repository.addTagAssets([tagId], assetIds);
    await rememberRecent(tagId);
  }

  Future<void> removeTag(String tagId, List<String> assetIds) async {
    if (assetIds.isEmpty) {
      return;
    }
    await _api.untagAssets(tagId, assetIds);
    await _repository.removeTagAssets(tagId, assetIds);
  }

  Future<void> setHidden(TagEntry tag, bool isHidden) async {
    final dto = await _api.updateTag(tag.id, isHidden: isHidden);
    await _repository.upsertTag(_toEntry(dto));
    _onTagsChanged();
  }

  /// The views whose rules name the tag, for the warning before deleting it
  Future<List<CustomView>> viewsUsingTag(String tagId) => _viewApi.getAll(tagId: tagId);

  Future<void> deleteTag(String tagId) async {
    await _api.deleteTag(tagId);
    await _repository.deleteTags([tagId]);
    _onTagsChanged();
  }

  /// For each tag, how many of [assetIds] carry it
  Future<Map<String, int>> countTagged(List<String> assetIds) => _repository.countTagged(assetIds);

  List<String> get recentTagIds {
    try {
      return (jsonDecode(Store.get(StoreKey.recentTagIds, '[]')) as List).cast<String>();
    } catch (_) {
      return const [];
    }
  }

  Future<void> rememberRecent(String tagId) {
    final recent = [tagId, ...recentTagIds.where((id) => id != tagId)].take(kRecentTagCount).toList();
    return Store.put(StoreKey.recentTagIds, jsonEncode(recent));
  }

  TagEntry _toEntry(TagResponseDto dto) => TagEntry(
    id: dto.id,
    ownerId: _ownerId(),
    value: dto.value,
    parentId: dto.parentId.orElse(null),
    color: dto.color.orElse(null),
    isHidden: dto.isHidden,
  );
}
