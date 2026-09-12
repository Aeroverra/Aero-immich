import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/main/table/remote/album.drift.dart';
import 'package:immich_mobile/data/db/main/table/remote/asset.drift.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';

extension RemoteAssetPrivateModeFilter on $RemoteAssetEntityTable {
  /// Mixed-owner predicate: `is_private = false OR (privateMode AND owner_id = me)`
  Expression<bool> privateFilter(PrivateModeFilter filter) {
    if (filter.showsOwnPrivate) {
      return isPrivate.equals(false) | ownerId.equals(filter.userId!);
    }
    return isPrivate.equals(false);
  }
}

extension RemoteAlbumPrivateModeFilter on $RemoteAssetEntityTable {
  /// Album predicate: `is_private = false OR privateMode`. Album views show
  /// private assets whenever the viewer's own private mode is on.
  Expression<bool> albumPrivateFilter(PrivateModeFilter filter) {
    if (filter.enabled) {
      return const Constant(true);
    }
    return isPrivate.equals(false);
  }
}

extension RemoteAlbumEntityPrivateModeFilter on $RemoteAlbumEntityTable {
  /// Albums themselves are only hidden when private and the mode is off
  Expression<bool> privateFilter(PrivateModeFilter filter) {
    if (filter.enabled) {
      return const Constant(true);
    }
    return isPrivate.equals(false);
  }
}
