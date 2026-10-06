import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:openapi/api.dart';

String getOriginalUrlForRemoteId(final String id, {bool edited = true}) {
  return '${Store.get(StoreKey.serverEndpoint)}/assets/$id/original?edited=$edited';
}

String getThumbnailUrlForRemoteId(
  final String id, {
  AssetMediaSize type = AssetMediaSize.thumbnail,
  bool edited = true,
  String? thumbhash,
}) {
  final url = '${Store.get(StoreKey.serverEndpoint)}/assets/$id/thumbnail?size=$type&edited=$edited';
  return thumbhash != null ? '$url&c=${Uri.encodeComponent(thumbhash)}' : url;
}

String getPlaybackUrlForRemoteId(final String id) {
  return '${Store.get(StoreKey.serverEndpoint)}/assets/$id/video/playback?';
}

/// The thumbnail of a person. [assetId] is the asset the person is shown with: when private mode or the active view
/// hides the feature photo, the server cuts the face from that asset. [scope] (see `personThumbnailScopeProvider`)
/// keeps faces cut for one view or private mode state apart from the others in the image cache.
String getFaceThumbnailUrl(final String personId, {DateTime? updatedAt, String? assetId, String? scope}) {
  final url = '${Store.get(StoreKey.serverEndpoint)}/people/$personId/thumbnail';
  final query = [
    if (updatedAt != null) 'c=${updatedAt.millisecondsSinceEpoch}',
    if (assetId != null) 'assetId=$assetId',
    if (scope != null) 'v=${Uri.encodeQueryComponent(scope)}',
  ];
  return query.isEmpty ? url : '$url?${query.join('&')}';
}
