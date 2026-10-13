import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/domain/services/user.service.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/repositories/custom_view_api.repository.dart';
import 'package:immich_mobile/services/local_auth.service.dart';
import 'package:immich_mobile/services/secure_storage.service.dart';
import 'package:mocktail/mocktail.dart';

import '../service.mocks.dart';

class _MockCustomViewApiRepository extends Mock implements CustomViewApiRepository {}

class _MockUserService extends Mock implements UserService {}

/// Flips the session state without talking to the server
class _TestPrivateModeNotifier extends PrivateModeNotifier {
  _TestPrivateModeNotifier(super.ref);

  void set(bool enabled) => state = enabled;

  @override
  Future<void> refresh() async {}
}

const _me = 'user-1';

const _defaultView = CustomView(id: 'default', ownerId: _me, name: 'Vetted', order: 0, isDefault: true);
const _openView = CustomView(id: 'open', ownerId: _me, name: 'Everything', order: 1);
const _lockedView = CustomView(id: 'locked', ownerId: _me, name: 'Gym', order: 2, access: ViewAccess.locked);
const _privateView = CustomView(id: 'private', ownerId: _me, name: 'Private', order: 3, access: ViewAccess.private);

void main() {
  late _MockCustomViewApiRepository api;
  late MockSecureStorageService secureStorage;
  late MockLocalAuthService localAuth;
  late ProviderContainer container;

  ProviderContainer createContainer({
    List<CustomView> views = const [_defaultView, _openView, _lockedView, _privateView],
  }) {
    final userService = _MockUserService();
    when(
      () => userService.tryGetMyUser(),
    ).thenReturn(UserDto(id: _me, email: 'me@test.dev', name: 'me', profileChangedAt: DateTime(2026)));
    when(() => userService.watchMyUser()).thenAnswer((_) => const Stream.empty());

    final container = ProviderContainer(
      overrides: [
        customViewsSupportedProvider.overrideWithValue(true),
        currentUserProvider.overrideWith((ref) => CurrentUserProvider(userService)),
        localViewsProvider.overrideWith((ref) => Stream.value(views)),
        localTagsProvider.overrideWith((ref) => Stream.value(const [])),
        privateModeProvider.overrideWith(_TestPrivateModeNotifier.new),
        customViewApiRepositoryProvider.overrideWithValue(api),
        secureStorageServiceProvider.overrideWithValue(secureStorage),
        localAuthServiceProvider.overrideWithValue(localAuth),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  Future<void> settle() => Future<void>.delayed(Duration.zero);

  _TestPrivateModeNotifier privateMode() => container.read(privateModeProvider.notifier) as _TestPrivateModeNotifier;

  setUp(() async {
    api = _MockCustomViewApiRepository();
    secureStorage = MockSecureStorageService();
    localAuth = MockLocalAuthService();
    when(() => api.setActive(any(), pinCode: any(named: 'pinCode'))).thenAnswer(
      (invocation) async => ActiveCustomView(
        viewId: invocation.positionalArguments.first as String?,
        expiresAt: DateTime.now().add(const Duration(minutes: 30)),
      ),
    );
    container = createContainer();
    container.listen(appliedViewProvider, (_, _) {});
    container.listen(switchableViewsProvider, (_, _) {});
    container.listen(privateModeFilterProvider, (_, _) {});
    await settle();
  });

  group('access tiers', () {
    test('the switcher lists private views only while private mode is unlocked', () async {
      expect(container.read(switchableViewsProvider).map((view) => view.id), ['default', 'open', 'locked']);

      privateMode().set(true);
      expect(container.read(switchableViewsProvider).map((view) => view.id), ['default', 'open', 'locked', 'private']);
    });

    test('the default view applies until another view is switched to', () async {
      expect(container.read(appliedViewProvider), _defaultView);
      expect(container.read(privateModeFilterProvider).view?.viewId, 'default');

      await container.read(activeViewProvider.notifier).switchTo(_openView);

      expect(container.read(appliedViewProvider), _openView);
      expect(container.read(privateModeFilterProvider).view?.viewId, 'open');
      verify(() => api.setActive('open')).called(1);
    });

    test('switching to the default view sends no view and no PIN', () async {
      await container.read(activeViewProvider.notifier).switchTo(_openView);
      await container.read(activeViewProvider.notifier).switchTo(_defaultView);

      verify(() => api.setActive(null)).called(1);
      expect(container.read(activeViewProvider), isNull);
    });

    test('a private view is only applied while private mode is unlocked', () async {
      privateMode().set(true);
      await container.read(activeViewProvider.notifier).switchTo(_privateView);
      expect(container.read(appliedViewProvider), _privateView);

      // the server drops it when private mode relocks; the app follows right away
      privateMode().set(false);
      expect(container.read(activeViewProvider), isNull);
      expect(container.read(appliedViewProvider), _defaultView);
    });

    test('a locked view needs the PIN code on every switch', () async {
      when(() => api.setActive('locked')).thenThrow(const CustomViewSwitchException(CustomViewSwitchError.pinRequired));
      when(
        () => api.setActive('locked', pinCode: '000000'),
      ).thenThrow(const CustomViewSwitchException(CustomViewSwitchError.wrongPin));
      final notifier = container.read(activeViewProvider.notifier);

      await expectLater(notifier.switchTo(_lockedView), throwsA(isA<CustomViewSwitchException>()));
      await expectLater(notifier.switchTo(_lockedView, pinCode: '000000'), throwsA(isA<CustomViewSwitchException>()));
      expect(container.read(appliedViewProvider), _defaultView);

      await notifier.switchTo(_lockedView, pinCode: '123456');
      expect(container.read(appliedViewProvider), _lockedView);
    });

    test('without views nothing is filtered', () async {
      container = createContainer(views: const []);
      container.listen(privateModeFilterProvider, (_, _) {});
      await settle();

      expect(container.read(appliedViewProvider), isNull);
      expect(container.read(privateModeFilterProvider).view, isNull);
    });
  });

  group('biometrics', () {
    test('switch with the PIN stored by the biometric enrolment', () async {
      when(() => secureStorage.read(kSecuredPinCode)).thenAnswer((_) async => '123456');
      when(() => localAuth.authenticate()).thenAnswer((_) async => true);

      final result = await container.read(activeViewProvider.notifier).switchWithBiometrics(_lockedView);

      expect(result, ViewBiometricResult.switched);
      verify(() => api.setActive('locked', pinCode: '123456')).called(1);
      expect(container.read(appliedViewProvider), _lockedView);
    });

    test('no enrolment or a cancelled prompt does not switch', () async {
      final notifier = container.read(activeViewProvider.notifier);
      when(() => secureStorage.read(kSecuredPinCode)).thenAnswer((_) async => null);
      expect(await notifier.switchWithBiometrics(_lockedView), ViewBiometricResult.notEnrolled);

      when(() => secureStorage.read(kSecuredPinCode)).thenAnswer((_) async => '123456');
      when(() => localAuth.authenticate()).thenThrow(PlatformException(code: 'cancelled'));
      expect(await notifier.switchWithBiometrics(_lockedView), ViewBiometricResult.failed);

      verifyNever(() => api.setActive('locked', pinCode: any(named: 'pinCode')));
      expect(container.read(appliedViewProvider), _defaultView);
    });

    test('a stored PIN the server rejects is dropped', () async {
      when(() => secureStorage.read(kSecuredPinCode)).thenAnswer((_) async => '000000');
      when(() => secureStorage.delete(kSecuredPinCode)).thenAnswer((_) async {});
      when(() => localAuth.authenticate()).thenAnswer((_) async => true);
      when(
        () => api.setActive('locked', pinCode: '000000'),
      ).thenThrow(const CustomViewSwitchException(CustomViewSwitchError.wrongPin));

      expect(
        await container.read(activeViewProvider.notifier).switchWithBiometrics(_lockedView),
        ViewBiometricResult.pinChanged,
      );
      verify(() => secureStorage.delete(kSecuredPinCode)).called(1);
    });
  });

  group('fallback to the default view', () {
    test('resetToDefault returns right away and tells the server', () async {
      final notifier = container.read(activeViewProvider.notifier);
      await notifier.switchTo(_openView);

      notifier.resetToDefault();

      expect(container.read(activeViewProvider), isNull);
      expect(container.read(appliedViewProvider), _defaultView);
      verify(() => api.setActive(null)).called(1);
    });

    test('the view follows the server when its timeout passes', () {
      fakeAsync((async) {
        var active = const ActiveCustomView(viewId: 'open');
        when(() => api.getActive()).thenAnswer((_) async => active);
        when(() => api.setActive('open', pinCode: any(named: 'pinCode'))).thenAnswer(
          (_) async => ActiveCustomView(viewId: 'open', expiresAt: DateTime.now().add(const Duration(minutes: 5))),
        );
        final notifier = container.read(activeViewProvider.notifier);

        unawaited(notifier.switchTo(_openView));
        async.flushMicrotasks();
        expect(container.read(activeViewProvider), 'open');
        expect(notifier.hasExpiryTimer, isTrue);

        // the server timed the view out
        active = const ActiveCustomView();
        async.elapse(const Duration(minutes: 6));
        async.flushMicrotasks();

        expect(container.read(activeViewProvider), isNull);
        expect(container.read(appliedViewProvider), _defaultView);
        verify(() => api.getActive()).called(1);
      });
    });

    test('refresh adopts the view of the session', () async {
      when(() => api.getActive()).thenAnswer((_) async => const ActiveCustomView(viewId: 'locked'));

      await container.read(activeViewProvider.notifier).refresh();

      expect(container.read(appliedViewProvider), _lockedView);
    });
  });
}
