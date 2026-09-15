import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/main/table/user/user.dart';
import 'package:immich_mobile/data/db/util/defaults_mixin.dart';
import 'package:immich_mobile/domain/models/stack.model.dart';

@TableIndex.sql('CREATE INDEX IF NOT EXISTS idx_stack_primary_asset_id ON stack_entity (primary_asset_id)')
class StackEntity extends Table with DriftDefaultsMixin {
  const StackEntity();

  TextColumn get id => text()();

  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();

  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();

  TextColumn get ownerId => text().references(UserEntity, #id, onDelete: KeyAction.cascade)();

  TextColumn get primaryAssetId => text()();

  IntColumn get source => intEnum<StackSource>().withDefault(const Constant(0))();

  @override
  Set<Column> get primaryKey => {id};
}
