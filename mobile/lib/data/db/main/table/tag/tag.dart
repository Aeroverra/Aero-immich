import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/util/defaults_mixin.dart';

/// Tags of the current user, hidden ones included (their names are hidden locally while private mode is locked).
/// Without foreign keys: a child can arrive before its parent in the sync stream, deletes cascade in the sync
/// repository.
@TableIndex.sql('CREATE INDEX IF NOT EXISTS idx_tag_parent_id ON tag_entity (parent_id)')
class TagEntity extends Table with DriftDefaultsMixin {
  const TagEntity();

  TextColumn get id => text()();

  TextColumn get ownerId => text()();

  TextColumn get value => text()();

  TextColumn get parentId => text().nullable()();

  TextColumn get color => text().nullable()();

  /// The tag's own flag; children of a hidden tag are hidden too
  BoolColumn get isHidden => boolean().withDefault(const Constant(false))();

  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();

  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();

  @override
  Set<Column> get primaryKey => {id};
}
