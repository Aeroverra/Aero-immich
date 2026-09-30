import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/providers/app_lock.provider.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/services/screen_state.service.dart';

class _TestPrivateModeNotifier extends PrivateModeNotifier {
  _TestPrivateModeNotifier(super.ref);

  int disableCount = 0;

  @override
  Future<void> refresh() async {}

  @override
  Future<void> disable() async {
    disableCount++;
    state = false;
  }
}

class _TestActiveViewNotifier extends ActiveViewNotifier {
  _TestActiveViewNotifier(super.ref);

  int resetCount = 0;

  @override
  Future<void> refresh() async {}

  @override
  void resetToDefault() {
    resetCount++;
    state = null;
  }
}

/// A screen state service that never touches the platform, so a test can say when the screen turned off
class _FakeScreenStateService extends ScreenStateService {
  _FakeScreenStateService({this.reported = true});

  final bool reported;
  final _controller = StreamController<void>.broadcast();

  @override
  Stream<void> get screenOff => _controller.stream;

  @override
  void listen() {}

  @override
  Future<bool> isReported() async => reported;

  void turnScreenOff() => _controller.add(null);

  @override
  void dispose() => unawaited(_controller.close());
}

void main() {
  late ProviderContainer container;
  late _FakeScreenStateService screen;
  late _TestPrivateModeNotifier privateMode;
  late _TestActiveViewNotifier view;

  /// Builds a container where private mode and views lock the given way, and turns both on
  Future<void> build({
    LockTrigger privateModeTrigger = LockTrigger.appPause,
    LockTrigger viewTrigger = LockTrigger.screenOff,
    int timeoutMinutes = 30,
    bool screenOffReported = true,
  }) async {
    screen = _FakeScreenStateService(reported: screenOffReported);
    container = ProviderContainer(
      overrides: [
        privateModeProvider.overrideWith(_TestPrivateModeNotifier.new),
        activeViewProvider.overrideWith(_TestActiveViewNotifier.new),
        screenStateServiceProvider.overrideWithValue(screen),
        privateModeLockTriggerProvider.overrideWithValue(privateModeTrigger),
        customViewLockTriggerProvider.overrideWithValue(viewTrigger),
        privateModeTimeoutMinutesProvider.overrideWithValue(timeoutMinutes),
      ],
    );
    privateMode = container.read(privateModeProvider.notifier) as _TestPrivateModeNotifier;
    view = container.read(activeViewProvider.notifier) as _TestActiveViewNotifier;
    privateMode.state = true;
    view.state = 'view-1';
    await container.read(appLockServiceProvider).start();
  }

  tearDown(() {
    container.dispose();
  });

  test('lock when leaving the app locks both on app pause', () async {
    await build(privateModeTrigger: LockTrigger.appPause, viewTrigger: LockTrigger.appPause);

    container.read(appLockServiceProvider).handleAppPause();

    expect(privateMode.disableCount, 1);
    expect(privateMode.state, isFalse);
    expect(view.resetCount, 1);
    expect(view.state, isNull);
  });

  test('lock when the screen turns off keeps the app pause unlocked', () async {
    await build(privateModeTrigger: LockTrigger.screenOff, viewTrigger: LockTrigger.screenOff);

    container.read(appLockServiceProvider).handleAppPause();

    expect(privateMode.disableCount, 0);
    expect(privateMode.state, isTrue);
    expect(view.resetCount, 0);
    expect(view.state, 'view-1');
  });

  test('lock when the screen turns off locks on the screen turning off', () async {
    await build(privateModeTrigger: LockTrigger.screenOff, viewTrigger: LockTrigger.screenOff);

    container.read(appLockServiceProvider).handleAppPause();
    screen.turnScreenOff();
    await Future<void>.delayed(Duration.zero);

    expect(privateMode.disableCount, 1);
    expect(privateMode.state, isFalse);
    expect(view.resetCount, 1);
    expect(view.state, isNull);
  });

  test('lock only after the timeout ignores the app pause and the screen turning off', () async {
    await build(privateModeTrigger: LockTrigger.timeout, viewTrigger: LockTrigger.timeout);

    container.read(appLockServiceProvider).handleAppPause();
    screen.turnScreenOff();
    await Future<void>.delayed(Duration.zero);

    expect(privateMode.disableCount, 0);
    expect(privateMode.state, isTrue);
    expect(view.resetCount, 0);
    expect(view.state, 'view-1');
  });

  test('the timeout still locks both while the app is in the background', () {
    fakeAsync((async) {
      unawaited(build(privateModeTrigger: LockTrigger.timeout, viewTrigger: LockTrigger.screenOff, timeoutMinutes: 15));
      async.flushMicrotasks();

      container.read(appLockServiceProvider).handleAppPause();
      async.elapse(const Duration(minutes: 14));

      expect(privateMode.disableCount, 0);
      expect(view.resetCount, 0);

      async.elapse(const Duration(minutes: 2));

      expect(privateMode.disableCount, 1);
      expect(privateMode.state, isFalse);
      expect(view.resetCount, 1);
      expect(view.state, isNull);
      async.flushTimers();
    });
  });

  test('coming back to the app drops the pending timeout, the server timeout takes over', () {
    fakeAsync((async) {
      unawaited(build(privateModeTrigger: LockTrigger.timeout, viewTrigger: LockTrigger.timeout, timeoutMinutes: 5));
      async.flushMicrotasks();
      final service = container.read(appLockServiceProvider);

      service.handleAppPause();
      expect(service.hasPendingTimers, isTrue);

      async.elapse(const Duration(minutes: 1));
      service.handleAppResume();
      async.elapse(const Duration(minutes: 10));

      expect(service.hasPendingTimers, isFalse);
      expect(privateMode.disableCount, 0);
      expect(privateMode.state, isTrue);
      expect(view.resetCount, 0);
      async.flushTimers();
    });
  });

  test('a manual lock always works, whatever the trigger is', () async {
    await build(privateModeTrigger: LockTrigger.timeout, viewTrigger: LockTrigger.timeout);

    await container.read(privateModeProvider.notifier).disable();
    container.read(activeViewProvider.notifier).resetToDefault();

    expect(privateMode.state, isFalse);
    expect(view.state, isNull);
  });

  test('views follow their own trigger, private mode keeps its own', () async {
    await build(privateModeTrigger: LockTrigger.timeout, viewTrigger: LockTrigger.appPause);

    container.read(appLockServiceProvider).handleAppPause();

    expect(privateMode.disableCount, 0);
    expect(privateMode.state, isTrue);
    expect(view.resetCount, 1);
    expect(view.state, isNull);
  });

  test('a platform without the screen off signal falls back to locking on app pause', () async {
    await build(
      privateModeTrigger: LockTrigger.screenOff,
      viewTrigger: LockTrigger.screenOff,
      screenOffReported: false,
    );

    container.read(appLockServiceProvider).handleAppPause();

    expect(privateMode.disableCount, 1);
    expect(privateMode.state, isFalse);
    expect(view.resetCount, 1);
    expect(view.state, isNull);
  });

  test('private mode follows its own trigger, views keep theirs', () async {
    await build(privateModeTrigger: LockTrigger.appPause, viewTrigger: LockTrigger.timeout);

    container.read(appLockServiceProvider).handleAppPause();
    await Future<void>.delayed(Duration.zero);

    expect(privateMode.disableCount, 1);
    expect(privateMode.state, isFalse);
    // the view only follows private mode because the server returns a relocked session to the default view
    expect(view.resetCount, 0);
  });
}
