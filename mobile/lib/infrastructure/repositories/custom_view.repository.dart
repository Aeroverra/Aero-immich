import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/data/db/main/table/tag/tag.drift.dart';
import 'package:immich_mobile/data/db/main/table/tag/tag_asset.drift.dart';
import 'package:immich_mobile/data/db/main/table/view/view.drift.dart';
import 'package:immich_mobile/data/db/main/table/view/view_tag.drift.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/infrastructure/repositories/custom_view.repository.drift.dart';

/// Local copies of the synced tags, tag links, views and view rules
@DriftAccessor()
class CustomViewRepository extends DatabaseAccessor<Drift> with $CustomViewRepositoryMixin {
  CustomViewRepository(super.attachedDatabase);

  Drift get _db => attachedDatabase;

  Stream<List<TagEntry>> watchTags(String ownerId) {
    final query = _db.tagEntity.select()
      ..where((row) => row.ownerId.equals(ownerId))
      ..orderBy([(row) => OrderingTerm.asc(row.value)]);
    return query.map((row) => row.toDto()).watch();
  }

  Future<List<TagEntry>> getTags(String ownerId) {
    final query = _db.tagEntity.select()
      ..where((row) => row.ownerId.equals(ownerId))
      ..orderBy([(row) => OrderingTerm.asc(row.value)]);
    return query.map((row) => row.toDto()).get();
  }

  /// Tags of the asset, in path order
  Stream<List<TagEntry>> watchAssetTags(String assetId) {
    final query =
        _db.tagEntity.select().join([
            innerJoin(_db.tagAssetEntity, _db.tagAssetEntity.tagId.equalsExp(_db.tagEntity.id), useColumns: false),
          ])
          ..where(_db.tagAssetEntity.assetId.equals(assetId))
          ..orderBy([OrderingTerm.asc(_db.tagEntity.value)]);
    return query.map((row) => row.readTable(_db.tagEntity).toDto()).watch();
  }

  /// For each of [tagIds], how many of [assetIds] carry it
  Future<Map<String, int>> countTagged(Iterable<String> assetIds) async {
    if (assetIds.isEmpty) {
      return const {};
    }
    final count = _db.tagAssetEntity.assetId.count();
    final query = _db.tagAssetEntity.selectOnly()
      ..addColumns([_db.tagAssetEntity.tagId, count])
      ..where(_db.tagAssetEntity.assetId.isIn(assetIds))
      ..groupBy([_db.tagAssetEntity.tagId]);
    final rows = await query.get();
    return {for (final row in rows) row.read(_db.tagAssetEntity.tagId)!: row.read(count)!};
  }

  Stream<List<CustomView>> watchViews(String ownerId) {
    return _db
        .customSelect('SELECT 1', readsFrom: {_db.viewEntity, _db.viewTagEntity})
        .watch()
        .asyncMap((_) => getViews(ownerId));
  }

  /// The views of [ownerId] in their display order, the default view first among equal orders
  Future<List<CustomView>> getViews(String ownerId) async {
    final views =
        await (_db.viewEntity.select()
              ..where((row) => row.ownerId.equals(ownerId))
              ..orderBy([
                (row) => OrderingTerm.asc(row.order),
                (row) => OrderingTerm.desc(row.isDefault),
                (row) => OrderingTerm.asc(row.name),
              ]))
            .get();
    if (views.isEmpty) {
      return const [];
    }

    final rules = await (_db.viewTagEntity.select()..where((row) => row.viewId.isIn(views.map((view) => view.id))))
        .get();
    return [
      for (final view in views)
        view.toDto(
          includeTagIds: [
            for (final rule in rules)
              if (rule.viewId == view.id && rule.mode == ViewTagMode.include) rule.tagId,
          ],
          excludeTagIds: [
            for (final rule in rules)
              if (rule.viewId == view.id && rule.mode == ViewTagMode.exclude) rule.tagId,
          ],
        ),
    ];
  }

  Future<void> upsertTag(TagEntry tag) {
    final companion = TagEntityCompanion(
      ownerId: Value(tag.ownerId),
      value: Value(tag.value),
      parentId: Value(tag.parentId),
      color: Value(tag.color),
      isHidden: Value(tag.isHidden),
    );
    return _db.tagEntity.insertOne(companion.copyWith(id: Value(tag.id)), onConflict: DoUpdate((_) => companion));
  }

  static const _subtree = '''
      WITH RECURSIVE subtree(id) AS (
        SELECT value FROM json_each(?)
        UNION
        SELECT t.id FROM tag_entity t INNER JOIN subtree s ON t.parent_id = s.id
      )''';

  /// How many assets carry [tagId] or one of its child tags, and how many child tags it has (all levels), for the
  /// confirmation before deleting it
  Future<({int assets, int children})> countTagUsage(String tagId) async {
    final variables = [
      Variable<String>(jsonEncode([tagId])),
    ];
    final row = await _db
        .customSelect(
          '$_subtree SELECT '
          '(SELECT COUNT(DISTINCT ta.asset_id) FROM tag_asset_entity ta WHERE ta.tag_id IN (SELECT id FROM subtree)) '
          'AS assets, (SELECT COUNT(*) - 1 FROM subtree) AS children',
          variables: variables,
          readsFrom: {_db.tagEntity, _db.tagAssetEntity},
        )
        .getSingle();
    return (assets: row.read<int>('assets'), children: row.read<int>('children'));
  }

  /// Gives [tagId] the full [value] after a rename and moves the values of its child tags along, as the server does
  Future<void> renameTag(String tagId, String value) async {
    await _db.transaction(() async {
      final tag = await (_db.tagEntity.select()..where((row) => row.id.equals(tagId))).getSingleOrNull();
      if (tag == null) {
        return;
      }
      final variables = [
        Variable<String>(jsonEncode([tagId])),
      ];
      final ids = await _db
          .customSelect('$_subtree SELECT id FROM subtree', variables: variables, readsFrom: {_db.tagEntity})
          .map((row) => row.read<String>('id'))
          .get();
      final children = await (_db.tagEntity.select()..where((row) => row.id.isIn(ids) & row.id.equals(tagId).not()))
          .get();
      final prefix = '${tag.value}/';
      await _db.batch((batch) {
        batch.update(_db.tagEntity, TagEntityCompanion(value: Value(value)), where: (row) => row.id.equals(tagId));
        for (final child in children) {
          if (child.value.startsWith(prefix)) {
            batch.update(
              _db.tagEntity,
              TagEntityCompanion(value: Value('$value/${child.value.substring(prefix.length)}')),
              where: (row) => row.id.equals(child.id),
            );
          }
        }
      });
    });
  }

  /// Deletes the tags with their child tags, their asset links and the view rules naming any of them
  Future<void> deleteTags(Iterable<String> tagIds) async {
    if (tagIds.isEmpty) {
      return;
    }

    final variables = [Variable<String>(jsonEncode(tagIds.toList()))];
    await _db.transaction(() async {
      final ids = await _db
          .customSelect('$_subtree SELECT id FROM subtree', variables: variables, readsFrom: {_db.tagEntity})
          .map((row) => row.read<String>('id'))
          .get();
      await _db.batch((batch) {
        batch.deleteWhere(_db.tagAssetEntity, (row) => row.tagId.isIn(ids));
        batch.deleteWhere(_db.viewTagEntity, (row) => row.tagId.isIn(ids));
        batch.deleteWhere(_db.tagEntity, (row) => row.id.isIn(ids));
      });
    });
  }

  Future<void> addTagAssets(Iterable<String> tagIds, Iterable<String> assetIds) {
    return _db.batch((batch) {
      batch.insertAll(_db.tagAssetEntity, [
        for (final tagId in tagIds)
          for (final assetId in assetIds) TagAssetEntityCompanion(tagId: Value(tagId), assetId: Value(assetId)),
      ], mode: InsertMode.insertOrIgnore);
    });
  }

  Future<void> removeTagAssets(String tagId, Iterable<String> assetIds) {
    return _db.tagAssetEntity.deleteWhere((row) => row.tagId.equals(tagId) & row.assetId.isIn(assetIds));
  }

  /// Replaces the local copy of [view] and its rules, as the server stores them after an edit
  Future<void> replaceView(CustomView view) {
    return _db.transaction(() async {
      final companion = ViewEntityCompanion(
        ownerId: Value(view.ownerId),
        name: Value(view.name),
        order: Value(view.order),
        isDefault: Value(view.isDefault),
        access: Value(view.access),
        includeAll: Value(view.includeAll),
        includeUntagged: Value(view.includeUntagged),
        privateAssets: Value(view.privateAssets),
      );
      if (view.isDefault) {
        // at most one default view per owner
        await (_db.update(_db.viewEntity)
              ..where((row) => row.ownerId.equals(view.ownerId) & row.id.equals(view.id).not()))
            .write(const ViewEntityCompanion(isDefault: Value(false)));
      }
      await _db.viewEntity.insertOne(companion.copyWith(id: Value(view.id)), onConflict: DoUpdate((_) => companion));
      await _db.viewTagEntity.deleteWhere((row) => row.viewId.equals(view.id));
      await _db.batch((batch) {
        batch.insertAll(_db.viewTagEntity, [
          for (final tagId in view.includeTagIds)
            ViewTagEntityCompanion(viewId: Value(view.id), tagId: Value(tagId), mode: const Value(ViewTagMode.include)),
          for (final tagId in view.excludeTagIds)
            ViewTagEntityCompanion(viewId: Value(view.id), tagId: Value(tagId), mode: const Value(ViewTagMode.exclude)),
        ], mode: InsertMode.insertOrReplace);
      });
    });
  }

  /// Deletes the views with their rules
  Future<void> deleteViews(Iterable<String> viewIds) {
    return _db.batch((batch) {
      batch.deleteWhere(_db.viewTagEntity, (row) => row.viewId.isIn(viewIds));
      batch.deleteWhere(_db.viewEntity, (row) => row.id.isIn(viewIds));
    });
  }
}

extension on TagEntityData {
  TagEntry toDto() =>
      TagEntry(id: id, ownerId: ownerId, value: value, parentId: parentId, color: color, isHidden: isHidden);
}

extension on ViewEntityData {
  CustomView toDto({required List<String> includeTagIds, required List<String> excludeTagIds}) => CustomView(
    id: id,
    ownerId: ownerId,
    name: name,
    order: order,
    isDefault: isDefault,
    access: access,
    includeAll: includeAll,
    includeUntagged: includeUntagged,
    privateAssets: privateAssets,
    includeTagIds: includeTagIds,
    excludeTagIds: excludeTagIds,
  );
}
