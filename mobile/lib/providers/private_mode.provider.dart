import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/services/auth.service.dart';
import 'package:immich_mobile/utils/cache/custom_image_cache.dart';
import 'package:logging/logging.dart';

/// Whether the current session has private mode turned on.
///
/// Private assets only show up in local queries while this is true; the server
/// keeps the authoritative state (with an inactivity timeout), this notifier
/// mirrors it and is re-seeded from `getAuthStatus()` on login and resume.
final privateModeProvider = StateNotifierProvider<PrivateModeNotifier, bool>((ref) => PrivateModeNotifier(ref));

final isPrivateModeProvider = Provider<bool>((ref) => ref.watch(privateModeProvider));

/// The filter every asset-listing query receives: private mode state plus the current user id
final privateModeFilterProvider = Provider<PrivateModeFilter>(
  (ref) => PrivateModeFilter(
    enabled: ref.watch(privateModeProvider),
    userId: ref.watch(currentUserProvider.select((user) => user?.id)),
  ),
);

class PrivateModeNotifier extends StateNotifier<bool> {
  final Ref _ref;

  /// Replaces the image cache eviction, used by tests that run without a painting binding
  @visibleForTesting
  final void Function(Iterable<String> assetIds)? evictImages;
  final _log = Logger('PrivateModeNotifier');
  Timer? _expiryTimer;

  PrivateModeNotifier(this._ref, {this.evictImages}) : super(false);

  /// Re-reads the session state from the server. Safe to call when logged out (stays off).
  Future<void> refresh() async {
    try {
      final status = await _ref.read(authServiceProvider).getPrivateModeStatus();
      if (!mounted) {
        return;
      }
      _scheduleExpiry(status.expiresAt);
      if (state && !status.enabled) {
        await _turnOffLocally();
        return;
      }
      state = status.enabled;
    } catch (error, stack) {
      _log.warning('Failed to read private mode status', error, stack);
    }
  }

  Future<bool> enable(String pinCode) async {
    final enabled = await _ref.read(authServiceProvider).enablePrivateMode(pinCode);
    if (!mounted) {
      return false;
    }
    if (enabled) {
      state = true;
      // Fetch the expiry the server assigned so the local state flips off in step with it
      unawaited(refresh());
    }
    return enabled;
  }

  /// Turns the mode off locally right away and tells the server without waiting for it.
  Future<void> disable() async {
    if (!state) {
      return;
    }
    unawaited(
      _ref
          .read(authServiceProvider)
          .disablePrivateMode()
          .catchError((error, stack) => _log.warning('Failed to disable private mode on the server', error, stack)),
    );
    await _turnOffLocally();
  }

  Future<void> _turnOffLocally() async {
    _scheduleExpiry(null);
    state = false;
    final userId = _ref.read(currentUserProvider)?.id;
    if (userId == null) {
      return;
    }
    try {
      final ids = await _ref.read(driftProvider).remoteAssetRepository.getPrivateAssetIds(userId);
      (evictImages ?? _evictFromImageCache)(ids);
    } catch (error, stack) {
      _log.warning('Failed to evict private images from the cache', error, stack);
    }
  }

  void _scheduleExpiry(DateTime? expiresAt) {
    _expiryTimer?.cancel();
    _expiryTimer = null;
    if (expiresAt == null) {
      return;
    }
    final remaining = expiresAt.difference(DateTime.now());
    if (remaining.isNegative) {
      return;
    }
    _expiryTimer = Timer(remaining, () {
      if (mounted) {
        unawaited(refresh());
      }
    });
  }

  static void _evictFromImageCache(Iterable<String> ids) {
    final cache = PaintingBinding.instance.imageCache;
    if (cache is CustomImageCache) {
      cache.evictAssets(ids);
    }
  }

  @override
  void dispose() {
    _expiryTimer?.cancel();
    super.dispose();
  }
}
