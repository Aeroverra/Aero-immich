import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/exif.model.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/repositories/asset_api.repository.dart';

final assetExifProvider = FutureProvider.autoDispose.family<ExifInfo?, BaseAsset>((ref, asset) {
  return ref.watch(assetServiceProvider).getExif(asset);
});

/// The upload dates of a remote asset, fetched once per asset while its details are shown
final assetUploadDatesProvider = FutureProvider.autoDispose.family<AssetUploadDates, String>((ref, remoteId) {
  return ref.watch(assetApiRepositoryProvider).uploadDates(remoteId);
});
