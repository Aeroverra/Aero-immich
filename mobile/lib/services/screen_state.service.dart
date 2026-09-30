import 'dart:async';

import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/platform/screen_state_api.g.dart';
import 'package:logging/logging.dart';

/// The screen turning off (or the device locking), as the platform reports it.
///
/// Platforms without a reliable signal report [isScreenOffReported] false; the app then treats
/// "lock when the screen turns off" like the stricter "lock when leaving the app".
class ScreenStateService implements ScreenStateFlutterApi {
  ScreenStateService({ScreenStateHostApi? hostApi}) : _hostApi = hostApi ?? ScreenStateHostApi();

  final ScreenStateHostApi _hostApi;
  final _log = Logger('ScreenStateService');
  final _controller = StreamController<void>.broadcast();

  /// Emits whenever the screen turns off
  Stream<void> get screenOff => _controller.stream;

  /// Starts listening for the platform signal. Safe to call more than once.
  void listen() {
    ScreenStateFlutterApi.setUp(this);
  }

  /// Whether the platform reports the screen turning off, false when the platform side is missing
  Future<bool> isReported() async {
    try {
      return await _hostApi.isScreenOffReported();
    } on PlatformException catch (error) {
      _log.info('The platform does not report the screen turning off: ${error.code}');
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  @override
  void onScreenOff() {
    if (!_controller.isClosed) {
      _controller.add(null);
    }
  }

  void dispose() {
    unawaited(_controller.close());
  }
}

final screenStateServiceProvider = Provider<ScreenStateService>((ref) {
  final service = ScreenStateService();
  ref.onDispose(service.dispose);
  return service;
});

/// Whether "lock when the screen turns off" can be offered on this device
final screenOffReportedProvider = FutureProvider<bool>((ref) => ref.watch(screenStateServiceProvider).isReported());
