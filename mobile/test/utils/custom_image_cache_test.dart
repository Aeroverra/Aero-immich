import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:immich_mobile/utils/cache/custom_image_cache.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late CustomImageCache cache;

  setUp(() {
    cache = CustomImageCache();
  });

  // A completer that never resolves keeps the entry tracked as pending in the underlying cache
  ImageStreamCompleter pending() => MultiFrameImageStreamCompleter(codec: Completer<ui.Codec>().future, scale: 1);

  group('evictAssets', () {
    test('drops every cached provider of the given assets and keeps the rest', () {
      final thumbA = RemoteImageProvider(url: 'http://server/assets/a/thumbnail', assetId: 'a');
      final fullA = RemoteFullImageProvider(
        assetId: 'a',
        thumbhash: 'ha',
        assetType: AssetType.image,
        isAnimated: false,
      );
      final thumbB = RemoteImageProvider(url: 'http://server/assets/b/thumbnail', assetId: 'b');
      final avatar = RemoteImageProvider(url: 'http://server/users/profile-image');

      for (final key in [thumbA, fullA, thumbB, avatar]) {
        cache.putIfAbsent(key, pending);
      }
      expect(cache.trackedAssetCount, 2);
      expect(cache.statusForKey(thumbA).pending, isTrue);
      expect(cache.statusForKey(fullA).pending, isTrue);

      cache.evictAssets(['a', 'unknown']);

      expect(cache.statusForKey(thumbA).untracked, isTrue);
      expect(cache.statusForKey(fullA).untracked, isTrue);
      expect(cache.statusForKey(thumbB).pending, isTrue);
      expect(cache.statusForKey(avatar).pending, isTrue);
      expect(cache.trackedAssetCount, 1);
    });

    test('clear forgets the tracked assets as well', () {
      cache.putIfAbsent(RemoteImageProvider(url: 'http://server/assets/a/thumbnail', assetId: 'a'), pending);
      expect(cache.trackedAssetCount, 1);

      cache.clear();

      expect(cache.trackedAssetCount, 0);
    });
  });
}
