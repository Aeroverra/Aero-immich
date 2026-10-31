import 'dart:convert';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/utils/asset_metadata.utils.dart';
import 'package:logging/logging.dart';

/// Custom metadata (e.g. Google Photos takeout fields) of a remote asset, keyed by remote asset id.
///
/// Any failure (offline, older server, ...) yields an empty list so the details sheet never breaks.
final assetMetadataProvider = FutureProvider.autoDispose.family<List<AssetMetadataEntry>, String>((ref, assetId) async {
  try {
    // Decoded by hand: the generated dto casts the value to non nullable objects, which throws on JSON nulls.
    final response = await ref.watch(apiServiceProvider).assetsApi.getAssetMetadataWithHttpInfo(assetId);
    if (response.statusCode >= 400) {
      throw Exception('Unexpected status ${response.statusCode}');
    }
    final json = jsonDecode(utf8.decode(response.bodyBytes));
    if (json is! List) {
      return const [];
    }
    return [
      for (final item in json)
        if (item is Map && item['key'] is String && item['value'] is Map)
          (key: item['key'] as String, value: Map<String, Object?>.from(item['value'] as Map)),
    ];
  } catch (error, stack) {
    Logger('assetMetadataProvider').warning('Failed to load metadata for $assetId', error, stack);
    return const [];
  }
});

/// Whether the custom fields section of the details sheet is expanded, kept for the app session.
final assetMetadataExpandedProvider = StateProvider<bool>((ref) => false);
