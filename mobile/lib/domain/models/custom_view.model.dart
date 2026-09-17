import 'package:collection/collection.dart';

/// Who may switch to a view. Do not change the order, the value is stored as its index.
enum ViewAccess {
  /// switchable any time
  open,

  /// needs the PIN code or biometrics on every switch
  locked,

  /// listed and usable only while private mode is unlocked
  private,
}

/// How a view treats private assets. Do not change the order, the value is stored as its index.
enum ViewPrivateAssets {
  /// never shows private assets
  hide,

  /// shows private assets while private mode is unlocked, like the library without a view
  unlocked,

  /// shows only private assets, and only while private mode is unlocked
  only,
}

/// Whether a tag rule of a view includes or excludes its assets. Do not change the order, the value is stored as its
/// index.
enum ViewTagMode { include, exclude }

/// A tag synced from the server. [isHidden] is the tag's own flag; children of a hidden tag are hidden too.
class TagEntry {
  final String id;
  final String ownerId;
  final String value;
  final String? parentId;
  final String? color;
  final bool isHidden;

  const TagEntry({
    required this.id,
    required this.ownerId,
    required this.value,
    this.parentId,
    this.color,
    this.isHidden = false,
  });

  /// The last path segment, "Gym" for "Hidden/Gym"
  String get name {
    final index = value.lastIndexOf('/');
    return index < 0 ? value : value.substring(index + 1);
  }

  @override
  bool operator ==(Object other) =>
      other is TagEntry &&
      other.id == id &&
      other.ownerId == ownerId &&
      other.value == value &&
      other.parentId == parentId &&
      other.color == color &&
      other.isHidden == isHidden;

  @override
  int get hashCode => Object.hash(id, ownerId, value, parentId, color, isHidden);

  @override
  String toString() => 'TagEntry($value, hidden: $isHidden)';
}

/// A saved view: include (everything, untagged, or any include tag and its descendants) minus exclude (any exclude tag
/// and its descendants), plus the private asset handling.
class CustomView {
  final String id;
  final String ownerId;
  final String name;
  final int order;
  final bool isDefault;
  final ViewAccess access;
  final bool includeAll;
  final bool includeUntagged;
  final ViewPrivateAssets privateAssets;
  final List<String> includeTagIds;
  final List<String> excludeTagIds;

  const CustomView({
    required this.id,
    required this.ownerId,
    required this.name,
    this.order = 0,
    this.isDefault = false,
    this.access = ViewAccess.open,
    this.includeAll = true,
    this.includeUntagged = false,
    this.privateAssets = ViewPrivateAssets.unlocked,
    this.includeTagIds = const [],
    this.excludeTagIds = const [],
  });

  CustomView copyWith({
    String? name,
    int? order,
    bool? isDefault,
    ViewAccess? access,
    bool? includeAll,
    bool? includeUntagged,
    ViewPrivateAssets? privateAssets,
    List<String>? includeTagIds,
    List<String>? excludeTagIds,
  }) => CustomView(
    id: id,
    ownerId: ownerId,
    name: name ?? this.name,
    order: order ?? this.order,
    isDefault: isDefault ?? this.isDefault,
    access: access ?? this.access,
    includeAll: includeAll ?? this.includeAll,
    includeUntagged: includeUntagged ?? this.includeUntagged,
    privateAssets: privateAssets ?? this.privateAssets,
    includeTagIds: includeTagIds ?? this.includeTagIds,
    excludeTagIds: excludeTagIds ?? this.excludeTagIds,
  );

  @override
  bool operator ==(Object other) =>
      other is CustomView &&
      other.id == id &&
      other.ownerId == ownerId &&
      other.name == name &&
      other.order == order &&
      other.isDefault == isDefault &&
      other.access == access &&
      other.includeAll == includeAll &&
      other.includeUntagged == includeUntagged &&
      other.privateAssets == privateAssets &&
      const ListEquality<String>().equals(other.includeTagIds, includeTagIds) &&
      const ListEquality<String>().equals(other.excludeTagIds, excludeTagIds);

  @override
  int get hashCode => Object.hash(
    id,
    ownerId,
    name,
    order,
    isDefault,
    access,
    includeAll,
    includeUntagged,
    privateAssets,
    Object.hashAll(includeTagIds),
    Object.hashAll(excludeTagIds),
  );

  @override
  String toString() => 'CustomView($name, default: $isDefault, access: ${access.name})';
}

/// The rule of the applied view as local queries evaluate it, with the tag ids already expanded to their descendants.
class ViewFilter {
  final String viewId;
  final String ownerId;
  final bool includeAll;
  final bool includeUntagged;
  final Set<String> includeTagIds;
  final Set<String> excludeTagIds;
  final ViewPrivateAssets privateAssets;

  const ViewFilter({
    required this.viewId,
    required this.ownerId,
    this.includeAll = true,
    this.includeUntagged = false,
    this.includeTagIds = const {},
    this.excludeTagIds = const {},
    this.privateAssets = ViewPrivateAssets.unlocked,
  });

  /// Builds the filter of [view], expanding every tag rule to the tag and all its descendants in [tags]
  factory ViewFilter.fromView(CustomView view, Iterable<TagEntry> tags) {
    final children = <String, List<String>>{};
    for (final tag in tags) {
      final parentId = tag.parentId;
      if (parentId != null) {
        children.putIfAbsent(parentId, () => []).add(tag.id);
      }
    }

    return ViewFilter(
      viewId: view.id,
      ownerId: view.ownerId,
      includeAll: view.includeAll,
      includeUntagged: view.includeUntagged,
      includeTagIds: expandTagIds(view.includeTagIds, children),
      excludeTagIds: expandTagIds(view.excludeTagIds, children),
      privateAssets: view.privateAssets,
    );
  }

  /// true when every asset passes, so queries can skip the predicate
  bool get isUnrestricted => includeAll && excludeTagIds.isEmpty && privateAssets == ViewPrivateAssets.unlocked;

  @override
  bool operator ==(Object other) =>
      other is ViewFilter &&
      other.viewId == viewId &&
      other.ownerId == ownerId &&
      other.includeAll == includeAll &&
      other.includeUntagged == includeUntagged &&
      other.privateAssets == privateAssets &&
      const SetEquality<String>().equals(other.includeTagIds, includeTagIds) &&
      const SetEquality<String>().equals(other.excludeTagIds, excludeTagIds);

  @override
  int get hashCode => Object.hash(
    viewId,
    ownerId,
    includeAll,
    includeUntagged,
    privateAssets,
    const SetEquality<String>().hash(includeTagIds),
    const SetEquality<String>().hash(excludeTagIds),
  );

  @override
  String toString() => 'ViewFilter($viewId)';
}

/// [tagIds] plus every descendant, following the parent to children map [children]
Set<String> expandTagIds(Iterable<String> tagIds, Map<String, List<String>> children) {
  final result = <String>{};
  final pending = [...tagIds];
  while (pending.isNotEmpty) {
    final id = pending.removeLast();
    if (result.add(id)) {
      pending.addAll(children[id] ?? const []);
    }
  }
  return result;
}

/// Ids of the tags that are hidden themselves or through an ancestor
Set<String> effectiveHiddenTagIds(Iterable<TagEntry> tags) {
  final children = <String, List<String>>{};
  for (final tag in tags) {
    final parentId = tag.parentId;
    if (parentId != null) {
      children.putIfAbsent(parentId, () => []).add(tag.id);
    }
  }
  return expandTagIds(tags.where((tag) => tag.isHidden).map((tag) => tag.id), children);
}
