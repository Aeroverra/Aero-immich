import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/services/screen_state.service.dart';

/// Decides when the app locks private mode again and when it returns to the default view.
///
/// Private mode and custom views each have their own `lockTrigger` preference:
///
/// * [LockTrigger.appPause] locks as soon as the app leaves the foreground, so every app switch relocks.
/// * [LockTrigger.screenOff] keeps the unlock across app switches (a share sheet, the target app) and locks when
///   the screen turns off or the device locks.
/// * [LockTrigger.timeout] never locks on an app switch or a screen off, only on the inactivity timeout.
///
/// The inactivity timeout applies in every mode. The server runs its own sliding timeout, but any request the app
/// makes in the background (a backup, a sync) renews it, so the timeout is also measured here from the moment the
/// app was left and the session is locked on the server when it passes.
class AppLockService {
  AppLockService(this._ref);

  final Ref _ref;
  StreamSubscription<void>? _screenOff;
  Timer? _privateModeTimer;
  Timer? _viewTimer;
  bool _screenOffReported = false;

  /// Starts listening for the screen turning off. Safe to call more than once.
  Future<void> start() async {
    if (_screenOff != null) {
      return;
    }
    final service = _ref.read(screenStateServiceProvider);
    service.listen();
    _screenOff = service.screenOff.listen((_) => handleScreenOff());
    _screenOffReported = await service.isReported();
  }

  /// A platform that does not report the screen turning off falls back to the stricter app pause, so
  /// "lock when the screen turns off" never leaves a session unlocked with nothing to lock it
  LockTrigger _effective(LockTrigger trigger) =>
      trigger == LockTrigger.screenOff && !_screenOffReported ? LockTrigger.appPause : trigger;

  /// The app left the foreground: lock what is set to lock on an app switch, and start the timeout for the rest
  void handleAppPause() {
    final timeout = Duration(minutes: _ref.read(privateModeTimeoutMinutesProvider));

    if (_effective(_ref.read(privateModeLockTriggerProvider)) == LockTrigger.appPause) {
      unawaited(_lockPrivateMode());
    } else {
      _privateModeTimer?.cancel();
      _privateModeTimer = Timer(timeout, () => unawaited(_lockPrivateMode()));
    }

    if (_effective(_ref.read(customViewLockTriggerProvider)) == LockTrigger.appPause) {
      _resetView();
    } else {
      _viewTimer?.cancel();
      _viewTimer = Timer(timeout, _resetView);
    }
  }

  /// The app is back in the foreground: the user is active again, so the server's own timeout takes over
  void handleAppResume() {
    _cancelTimers();
  }

  /// The screen turned off or the device locked: everything but [LockTrigger.timeout] locks now
  void handleScreenOff() {
    _cancelTimers();

    if (_ref.read(privateModeLockTriggerProvider) != LockTrigger.timeout) {
      unawaited(_lockPrivateMode());
    }
    if (_ref.read(customViewLockTriggerProvider) != LockTrigger.timeout) {
      _resetView();
    }
  }

  Future<void> _lockPrivateMode() => _ref.read(privateModeProvider.notifier).disable();

  void _resetView() => _ref.read(activeViewProvider.notifier).resetToDefault();

  void _cancelTimers() {
    _privateModeTimer?.cancel();
    _privateModeTimer = null;
    _viewTimer?.cancel();
    _viewTimer = null;
  }

  @visibleForTesting
  bool get hasPendingTimers => _privateModeTimer != null || _viewTimer != null;

  void dispose() {
    unawaited(_screenOff?.cancel());
    _screenOff = null;
    _cancelTimers();
  }
}

final appLockServiceProvider = Provider<AppLockService>((ref) {
  final service = AppLockService(ref);
  ref.onDispose(service.dispose);
  return service;
});
