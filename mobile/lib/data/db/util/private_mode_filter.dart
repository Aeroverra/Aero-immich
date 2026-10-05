import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/data/db/main/table/remote/album.drift.dart';
import 'package:immich_mobile/data/db/main/table/remote/asset.drift.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';

extension RemoteAssetPrivateModeFilter on $RemoteAssetEntityTable {
  /// Mixed-owner predicate: `is_private = false OR (privateMode AND owner_id = me)`, and the applied view
  Expression<bool> privateFilter(PrivateModeFilter filter) {
    final Expression<bool> private = filter.showsOwnPrivate
        ? isPrivate.equals(false) | ownerId.equals(filter.userId!)
        : isPrivate.equals(false);
    final view = filter.restrictingView;
    return view == null ? private : private & viewFilter(view);
  }

  /// Whether the asset passes [view]: included (everything, untagged, or an include tag or descendant) and not
  /// excluded (an exclude tag or descendant), plus the private asset handling. Mirrors the server predicate: the
  /// hidden motion part of a live photo also carries the tags of its still, so it follows the still in and out of
  /// views (an album holding a hidden still and its untagged motion part must not count as visible).
  Expression<bool> viewFilter(ViewFilter view) {
    final db = attachedDatabase as Drift;

    Expression<bool> hasTag(Set<String> tagIds, Expression<String> assetId) => existsQuery(
      db.tagAssetEntity.selectOnly()
        ..addColumns([db.tagAssetEntity.tagId])
        ..where(db.tagAssetEntity.assetId.equalsExp(assetId) & db.tagAssetEntity.tagId.isIn(tagIds)),
    );

    // any tag of the view owner counts, hidden ones included
    Expression<bool> hasOwnerTag(Expression<String> assetId) => existsQuery(
      db.tagAssetEntity.selectOnly().join([
          innerJoin(db.tagEntity, db.tagEntity.id.equalsExp(db.tagAssetEntity.tagId), useColumns: false),
        ])
        ..addColumns([db.tagAssetEntity.tagId])
        ..where(db.tagAssetEntity.assetId.equalsExp(assetId) & db.tagEntity.ownerId.equals(view.ownerId)),
    );

    Expression<bool> withLivePhotoStill(Expression<bool> Function(Expression<String> assetId) match) {
      final still = db.alias(db.remoteAssetEntity, 'live_photo_still');
      return match(id) |
          (visibility.equalsValue(AssetVisibility.hidden) &
              existsQuery(
                still.selectOnly()
                  ..addColumns([still.id])
                  ..where(still.livePhotoVideoId.equalsExp(id) & match(still.id)),
              ));
    }

    final included = <Expression<bool>>[];
    if (view.includeAll) {
      included.add(const Constant(true));
    } else {
      if (view.includeUntagged) {
        included.add(withLivePhotoStill(hasOwnerTag).not());
      }
      if (view.includeTagIds.isNotEmpty) {
        included.add(withLivePhotoStill((assetId) => hasTag(view.includeTagIds, assetId)));
      }
    }

    var predicate = included.isEmpty ? const Constant(false) : Expression.or(included);
    if (view.excludeTagIds.isNotEmpty) {
      predicate = predicate & withLivePhotoStill((assetId) => hasTag(view.excludeTagIds, assetId)).not();
    }
    return switch (view.privateAssets) {
      ViewPrivateAssets.hide => predicate & isPrivate.equals(false),
      ViewPrivateAssets.unlocked => predicate,
      ViewPrivateAssets.only => predicate & isPrivate.equals(true),
    };
  }
}

extension RemoteAlbumPrivateModeFilter on $RemoteAssetEntityTable {
  /// Album predicate: `is_private = false OR privateMode`. Album views show
  /// private assets whenever the viewer's own private mode is on. The applied view
  /// filters album contents too.
  Expression<bool> albumPrivateFilter(PrivateModeFilter filter) {
    final Expression<bool> private = filter.enabled ? const Constant(true) : isPrivate.equals(false);
    final view = filter.restrictingView;
    return view == null ? private : private & viewFilter(view);
  }
}

extension RemoteAlbumEntityPrivateModeFilter on $RemoteAlbumEntityTable {
  /// Album level predicate: `is_private = false OR privateMode`. A private album is hidden as a
  /// whole while the mode is off (lists, counts, lookups and its timeline), matching the server
  /// which omits it from GET /albums and rejects it with 400.
  ///
  /// With a view applied, an album is also hidden when it holds assets but none of them passes the
  /// view; truly empty albums stay.
  Expression<bool> privateFilter(PrivateModeFilter filter) {
    final Expression<bool> private = filter.enabled ? const Constant(true) : isPrivate.equals(false);
    final view = filter.restrictingView;
    if (view == null) {
      return private;
    }

    final db = attachedDatabase as Drift;
    final asset = db.alias(db.remoteAssetEntity, 'view_album_asset');
    final albumAsset = db.alias(db.remoteAlbumAssetEntity, 'view_album_link');
    JoinedSelectStatement assets({required bool visible}) =>
        db.selectOnly(albumAsset).join([innerJoin(asset, asset.id.equalsExp(albumAsset.assetId), useColumns: false)])
          ..addColumns([albumAsset.assetId])
          ..where(
            albumAsset.albumId.equalsExp(id) &
                asset.deletedAt.isNull() &
                (visible ? asset.albumPrivateFilter(filter) : const Constant(true)),
          );
    // albums without assets (or with trashed ones only) stay, like without a view
    final albumAssets = assets(visible: false);
    final visibleAssets = assets(visible: true);
    return private & (notExistsQuery(albumAssets) | existsQuery(visibleAssets));
  }
}
