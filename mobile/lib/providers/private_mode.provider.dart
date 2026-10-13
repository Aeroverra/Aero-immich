import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/services/auth.service.dart';
import 'package:immich_mobile/services/local_auth.service.dart';
import 'package:immich_mobile/services/secure_storage.service.dart';
import 'package:immich_mobile/utils/cache/custom_image_cache.dart';
import 'package:logging/logging.dart';

/// Whether the current session has private mode turned on.
///
/// Private assets only show up in local queries while this is true; the server
/// keeps the authoritative state (with an inactivity timeout), this notifier
/// mirrors it and is re-seeded from `getAuthStatus()` on login and resume.
final privateModeProvider = StateNotifierProvider<PrivateModeNotifier, bool>((ref) => PrivateModeNotifier(ref));

final isPrivateModeProvider = Provider<bool>((ref) => ref.watch(privateModeProvider));

/// The filter every asset-listing query receives: private mode state plus the current user id, and the applied
/// custom view
final privateModeFilterProvider = Provider<PrivateModeFilter>(
  (ref) => PrivateModeFilter(
    enabled: ref.watch(privateModeProvider),
    userId: ref.watch(currentUserProvider.select((user) => user?.id)),
    view: ref.watch(appliedViewFilterProvider),
  ),
);

/// Outcome of turning private mode on with the PIN stored by the biometric enrolment
enum PrivateModeBiometricResult {
  /// No PIN is stored, the user never enrolled biometrics
  notEnrolled,

  /// The biometric prompt was cancelled or unavailable, or the server could not be reached
  failed,

  /// The stored PIN no longer matches the server and the enrolment was cleared
  pinChanged,

  enabled,
}

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

  /// Turns the mode on with the PIN stored by the biometric enrolment, after a biometric check.
  ///
  /// The enrolment is the one the locked folder uses (same secure storage key), so enrolling in
  /// either place works in both. Like the locked folder, a stored PIN the server rejects is
  /// dropped so the user is asked for the PIN again.
  Future<PrivateModeBiometricResult> enableWithBiometrics() async {
    final secureStorage = _ref.read(secureStorageServiceProvider);
    final pinCode = await secureStorage.read(kSecuredPinCode);
    if (pinCode == null) {
      return PrivateModeBiometricResult.notEnrolled;
    }

    try {
      if (!await _ref.read(localAuthServiceProvider).authenticate()) {
        return PrivateModeBiometricResult.failed;
      }
    } on PlatformException catch (error) {
      _log.warning('Biometric authentication failed: ${error.code}');
      return PrivateModeBiometricResult.failed;
    }

    try {
      if (await enable(pinCode)) {
        return PrivateModeBiometricResult.enabled;
      }
    } catch (error, stack) {
      _log.warning('Failed to enable private mode with the stored PIN', error, stack);
      return PrivateModeBiometricResult.failed;
    }

    await secureStorage.delete(kSecuredPinCode);
    return PrivateModeBiometricResult.pinChanged;
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
