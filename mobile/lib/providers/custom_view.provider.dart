import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/server_info.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/repositories/custom_view_api.repository.dart';
import 'package:immich_mobile/services/local_auth.service.dart';
import 'package:immich_mobile/services/secure_storage.service.dart';
import 'package:logging/logging.dart';

/// Whether the server knows custom views and hidden tags
final customViewsSupportedProvider = Provider<bool>(
  (ref) => ref.watch(serverInfoProvider.select((info) => info.serverFeatures.customViews)),
);

/// The synced tags of the current user, hidden ones included
final localTagsProvider = StreamProvider<List<TagEntry>>((ref) {
  final userId = ref.watch(currentUserProvider.select((user) => user?.id));
  if (userId == null || !ref.watch(customViewsSupportedProvider)) {
    return Stream.value(const []);
  }
  return ref.watch(driftProvider).customViewRepository.watchTags(userId);
});

/// Ids of the tags whose names stay hidden while private mode is locked (hidden tags and their descendants). Empty
/// while private mode is unlocked.
final lockedHiddenTagIdsProvider = Provider<Set<String>>((ref) {
  if (ref.watch(privateModeProvider)) {
    return const {};
  }
  return effectiveHiddenTagIds(ref.watch(localTagsProvider).valueOrNull ?? const []);
});

/// The synced tags the user may see now: hidden tags only while private mode is unlocked
final visibleTagsProvider = Provider<List<TagEntry>>((ref) {
  final tags = ref.watch(localTagsProvider).valueOrNull ?? const [];
  final hidden = ref.watch(lockedHiddenTagIdsProvider);
  return hidden.isEmpty ? tags : tags.where((tag) => !hidden.contains(tag.id)).toList();
});

/// The synced views of the current user in display order
final localViewsProvider = StreamProvider<List<CustomView>>((ref) {
  final userId = ref.watch(currentUserProvider.select((user) => user?.id));
  if (userId == null || !ref.watch(customViewsSupportedProvider)) {
    return Stream.value(const []);
  }
  return ref.watch(driftProvider).customViewRepository.watchViews(userId);
});

/// The views the switcher lists: the default view, open and locked views, and views with private access only while
/// private mode is unlocked
final switchableViewsProvider = Provider<List<CustomView>>((ref) {
  final views = ref.watch(localViewsProvider).valueOrNull ?? const [];
  final privateMode = ref.watch(privateModeProvider);
  return views.where((view) => view.access != ViewAccess.private || privateMode).toList();
});

/// The view the library is filtered by: the switched view, or the default view (null when there is none)
final appliedViewProvider = Provider<CustomView?>((ref) {
  final views = ref.watch(localViewsProvider).valueOrNull ?? const [];
  final viewId = ref.watch(activeViewProvider);
  final privateMode = ref.watch(privateModeProvider);

  CustomView? switched;
  for (final view in views) {
    if (view.id == viewId) {
      switched = view;
    }
  }
  if (switched != null && (switched.access != ViewAccess.private || privateMode)) {
    return switched;
  }
  for (final view in views) {
    if (view.isDefault) {
      return view;
    }
  }
  return null;
});

/// The applied view as local queries evaluate it
final appliedViewFilterProvider = Provider<ViewFilter?>((ref) {
  final view = ref.watch(appliedViewProvider);
  if (view == null) {
    return null;
  }
  return ViewFilter.fromView(view, ref.watch(localTagsProvider).valueOrNull ?? const []);
});

/// The view the current session switched to, null for the default view. The server keeps the authoritative state
/// (it falls back to the default view when private mode relocks or the view times out); this notifier mirrors it,
/// re-reads it on login and resume, and returns to the default view whenever the app leaves the foreground.
final activeViewProvider = StateNotifierProvider<ActiveViewNotifier, String?>((ref) => ActiveViewNotifier(ref));

/// Outcome of a switch with the PIN stored by the biometric enrolment
enum ViewBiometricResult {
  /// no PIN is stored, the user never enrolled biometrics
  notEnrolled,

  /// the biometric prompt was cancelled or unavailable
  failed,

  /// the stored PIN no longer matches the server and the enrolment was cleared
  pinChanged,

  switched,
}

class ActiveViewNotifier extends StateNotifier<String?> {
  final Ref _ref;
  final _log = Logger('ActiveViewNotifier');
  Timer? _expiryTimer;

  ActiveViewNotifier(this._ref) : super(null) {
    // private mode relocking sends the server session back to the default view
    _ref.listen<bool>(privateModeProvider, (previous, next) {
      if (previous == true && !next) {
        _setLocally(null);
      }
    });
  }

  CustomViewApiRepository get _api => _ref.read(customViewApiRepositoryProvider);

  bool get _isSupported => _ref.read(customViewsSupportedProvider);

  /// Re-reads the session view from the server. Stays on the default view when the server does not know views.
  Future<void> refresh() async {
    if (!_isSupported) {
      _setLocally(null);
      return;
    }
    try {
      final active = await _api.getActive();
      if (!mounted) {
        return;
      }
      state = active.viewId;
      _scheduleExpiry(active.viewId == null ? null : active.expiresAt);
    } catch (error, stack) {
      _log.warning('Failed to read the active view', error, stack);
    }
  }

  /// Switches the session to [view], or back to the default view with null. Throws [CustomViewSwitchException] when
  /// the server refuses, for example a locked view without the right [pinCode].
  Future<void> switchTo(CustomView? view, {String? pinCode}) async {
    final viewId = view == null || view.isDefault ? null : view.id;
    final active = await _api.setActive(viewId, pinCode: pinCode);
    if (!mounted) {
      return;
    }
    state = active.viewId;
    _scheduleExpiry(active.viewId == null ? null : active.expiresAt);
  }

  /// Switches to a locked [view] with the PIN stored by the biometric enrolment (shared with private mode and the
  /// locked folder), after a biometric check. A stored PIN the server rejects is dropped, like private mode does.
  Future<ViewBiometricResult> switchWithBiometrics(CustomView view) async {
    final secureStorage = _ref.read(secureStorageServiceProvider);
    final pinCode = await secureStorage.read(kSecuredPinCode);
    if (pinCode == null) {
      return ViewBiometricResult.notEnrolled;
    }

    try {
      if (!await _ref.read(localAuthServiceProvider).authenticate()) {
        return ViewBiometricResult.failed;
      }
    } on PlatformException catch (error) {
      _log.warning('Biometric authentication failed: ${error.code}');
      return ViewBiometricResult.failed;
    }

    try {
      await switchTo(view, pinCode: pinCode);
      return ViewBiometricResult.switched;
    } on CustomViewSwitchException catch (error) {
      if (error.error != CustomViewSwitchError.wrongPin) {
        rethrow;
      }
    }

    await secureStorage.delete(kSecuredPinCode);
    return ViewBiometricResult.pinChanged;
  }

  /// Returns to the default view right away and tells the server without waiting for it
  void resetToDefault() {
    if (state == null) {
      return;
    }
    _setLocally(null);
    if (_isSupported) {
      unawaited(
        _api
            .setActive(null)
            .then((_) {})
            .catchError((Object error, StackTrace stack) => _log.warning('Failed to reset the view', error, stack)),
      );
    }
  }

  void _setLocally(String? viewId) {
    _scheduleExpiry(null);
    if (mounted) {
      state = viewId;
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
    // the server renews the timeout while the app is used, so ask again instead of switching blindly
    _expiryTimer = Timer(remaining, () {
      if (mounted) {
        unawaited(refresh());
      }
    });
  }

  @visibleForTesting
  bool get hasExpiryTimer => _expiryTimer != null;

  @override
  void dispose() {
    _expiryTimer?.cancel();
    super.dispose();
  }
}
