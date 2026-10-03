import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/services/auth.service.dart';
import 'package:immich_mobile/services/local_auth.service.dart';
import 'package:immich_mobile/services/secure_storage.service.dart';
import 'package:mocktail/mocktail.dart';

import '../service.mocks.dart';

/// Private mode unlocks with the biometric enrolment the locked folder made (and vice versa):
/// one PIN under one secure storage key, checked with the same biometric prompt.
void main() {
  const pinCode = '123456';

  late MockAuthService authService;
  late MockSecureStorageService secureStorage;
  late MockLocalAuthService localAuth;
  late MockUserService userService;
  late ProviderContainer container;
  late PrivateModeNotifier notifier;

  setUp(() {
    authService = MockAuthService();
    secureStorage = MockSecureStorageService();
    localAuth = MockLocalAuthService();
    userService = MockUserService();

    when(() => userService.tryGetMyUser()).thenReturn(null);
    when(() => userService.watchMyUser()).thenAnswer((_) => const Stream.empty());
    when(() => authService.getPrivateModeStatus()).thenAnswer((_) async => const PrivateModeStatus(enabled: true));
    when(() => authService.disablePrivateMode()).thenAnswer((_) async {});
    when(() => secureStorage.delete(any())).thenAnswer((_) async {});

    container = ProviderContainer(
      overrides: [
        authServiceProvider.overrideWithValue(authService),
        secureStorageServiceProvider.overrideWithValue(secureStorage),
        localAuthServiceProvider.overrideWithValue(localAuth),
        currentUserProvider.overrideWith((ref) => CurrentUserProvider(userService)),
      ],
    );
    notifier = container.read(privateModeProvider.notifier);
  });

  tearDown(() => container.dispose());

  void storedPin(String? value) => when(() => secureStorage.read(kSecuredPinCode)).thenAnswer((_) async => value);

  test('without an enrolment the biometric prompt is never shown', () async {
    storedPin(null);

    expect(await notifier.enableWithBiometrics(), PrivateModeBiometricResult.notEnrolled);

    verifyNever(() => localAuth.authenticate(any()));
    verifyNever(() => authService.enablePrivateMode(any()));
    expect(container.read(privateModeProvider), isFalse);
  });

  test('a stored PIN turns the mode on after the biometric check', () async {
    storedPin(pinCode);
    when(() => localAuth.authenticate(any())).thenAnswer((_) async => true);
    when(() => authService.enablePrivateMode(pinCode)).thenAnswer((_) async => true);

    expect(await notifier.enableWithBiometrics(), PrivateModeBiometricResult.enabled);

    verify(() => authService.enablePrivateMode(pinCode)).called(1);
    verifyNever(() => secureStorage.delete(any()));
    expect(container.read(privateModeProvider), isTrue);
  });

  test('a cancelled biometric prompt keeps the enrolment and the mode off', () async {
    storedPin(pinCode);
    when(() => localAuth.authenticate(any())).thenAnswer((_) async => false);

    expect(await notifier.enableWithBiometrics(), PrivateModeBiometricResult.failed);

    verifyNever(() => authService.enablePrivateMode(any()));
    verifyNever(() => secureStorage.delete(any()));
    expect(container.read(privateModeProvider), isFalse);
  });

  test('an unavailable biometric sensor keeps the enrolment and the mode off', () async {
    storedPin(pinCode);
    when(() => localAuth.authenticate(any())).thenThrow(PlatformException(code: 'NotAvailable'));

    expect(await notifier.enableWithBiometrics(), PrivateModeBiometricResult.failed);

    verifyNever(() => authService.enablePrivateMode(any()));
    verifyNever(() => secureStorage.delete(any()));
    expect(container.read(privateModeProvider), isFalse);
  });

  test('an unreachable server keeps the enrolment and the mode off', () async {
    storedPin(pinCode);
    when(() => localAuth.authenticate(any())).thenAnswer((_) async => true);
    when(() => authService.enablePrivateMode(pinCode)).thenThrow(Exception('offline'));

    expect(await notifier.enableWithBiometrics(), PrivateModeBiometricResult.failed);

    verifyNever(() => secureStorage.delete(any()));
    expect(container.read(privateModeProvider), isFalse);
  });

  test('a PIN the server rejects clears the enrolment, like the locked folder', () async {
    storedPin(pinCode);
    when(() => localAuth.authenticate(any())).thenAnswer((_) async => true);
    when(() => authService.enablePrivateMode(pinCode)).thenAnswer((_) async => false);

    expect(await notifier.enableWithBiometrics(), PrivateModeBiometricResult.pinChanged);

    verify(() => secureStorage.delete(kSecuredPinCode)).called(1);
    expect(container.read(privateModeProvider), isFalse);
  });

  test('turning the mode off (app pause, toggle, expiry) keeps the enrolment', () async {
    storedPin(pinCode);
    when(() => localAuth.authenticate(any())).thenAnswer((_) async => true);
    when(() => authService.enablePrivateMode(pinCode)).thenAnswer((_) async => true);
    await notifier.enableWithBiometrics();
    // Let the expiry refresh that enabling kicks off finish first
    await Future<void>.delayed(Duration.zero);

    await notifier.disable();

    expect(container.read(privateModeProvider), isFalse);
    verifyNever(() => secureStorage.delete(any()));
    verifyNever(() => secureStorage.write(any(), any()));
  });
}
