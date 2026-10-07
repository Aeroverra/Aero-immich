import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/util/defaults_mixin.dart';

/// Which assets carry which tag. Without foreign keys so a link never fails a sync batch; tag and asset deletes
/// remove the links in the sync repository.
@TableIndex.sql('CREATE INDEX IF NOT EXISTS idx_tag_asset_asset_id ON tag_asset_entity (asset_id)')
class TagAssetEntity extends Table with DriftDefaultsMixin {
  const TagAssetEntity();

  TextColumn get tagId => text()();

  TextColumn get assetId => text()();

  @override
  Set<Column> get primaryKey => {tagId, assetId};
}
