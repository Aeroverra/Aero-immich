import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/util/defaults_mixin.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';

/// Saved views of the current user
class ViewEntity extends Table with DriftDefaultsMixin {
  const ViewEntity();

  TextColumn get id => text()();

  TextColumn get ownerId => text()();

  TextColumn get name => text()();

  IntColumn get order => integer().withDefault(const Constant(0))();

  BoolColumn get isDefault => boolean().withDefault(const Constant(false))();

  IntColumn get access => intEnum<ViewAccess>()();

  BoolColumn get includeAll => boolean().withDefault(const Constant(true))();

  BoolColumn get includeUntagged => boolean().withDefault(const Constant(false))();

  IntColumn get privateAssets => intEnum<ViewPrivateAssets>()();

  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();

  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();

  @override
  Set<Column> get primaryKey => {id};
}
