import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/util/defaults_mixin.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';

/// Include and exclude tag rules of the views. Without foreign keys, view and tag deletes remove the rules in the
/// sync repository.
@TableIndex.sql('CREATE INDEX IF NOT EXISTS idx_view_tag_tag_id ON view_tag_entity (tag_id)')
class ViewTagEntity extends Table with DriftDefaultsMixin {
  const ViewTagEntity();

  TextColumn get viewId => text()();

  TextColumn get tagId => text()();

  IntColumn get mode => intEnum<ViewTagMode>()();

  @override
  Set<Column> get primaryKey => {viewId, tagId};
}
