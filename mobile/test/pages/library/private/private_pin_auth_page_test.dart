import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/locales.dart';
import 'package:immich_mobile/generated/codegen_loader.g.dart';
import 'package:immich_mobile/models/auth/biometric_status.model.dart';
import 'package:immich_mobile/pages/library/private/private_pin_auth.page.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/providers/local_auth.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/widgets/forms/pin_registration_form.dart';
import 'package:immich_mobile/widgets/forms/pin_verification_form.dart';
import 'package:mocktail/mocktail.dart';
// ignore: import_rule_openapi
import 'package:openapi/api.dart';

import '../../../service.mocks.dart';
import '../../../test_utils.dart';

class _MockAuthenticationApi extends Mock implements AuthenticationApi {}

/// Answers the biometric unlock without secure storage or a sensor
class _TestPrivateModeNotifier extends PrivateModeNotifier {
  _TestPrivateModeNotifier(super.ref, this.result);

  final Completer<PrivateModeBiometricResult> result;
  int biometricAttempts = 0;

  @override
  Future<PrivateModeBiometricResult> enableWithBiometrics() {
    biometricAttempts++;
    return result.future;
  }

  @override
  Future<void> refresh() async {}
}

/// Opening the page (app bar toggle or private folder) tries the biometric enrolment first and
/// only falls back to the PIN pad when that does not turn the mode on.
void main() {
  late MockApiService apiService;
  late _MockAuthenticationApi authenticationApi;
  late MockLocalAuthService localAuth;
  late MockSecureStorageService secureStorage;
  late Completer<PrivateModeBiometricResult> biometricResult;
  late _TestPrivateModeNotifier privateMode;

  setUpAll(() => TestUtils.init());

  Future<void> pumpFrames(WidgetTester tester) async {
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  setUp(() {
    apiService = MockApiService();
    authenticationApi = _MockAuthenticationApi();
    localAuth = MockLocalAuthService();
    secureStorage = MockSecureStorageService();

    when(() => apiService.authenticationApi).thenReturn(authenticationApi);
    when(() => authenticationApi.getAuthStatus()).thenAnswer(
      (_) async => AuthStatusResponseDto(isElevated: false, password: true, pinCode: true, privateMode: false),
    );
    when(
      () => localAuth.getStatus(),
    ).thenAnswer((_) async => const BiometricStatus(availableBiometrics: [], canAuthenticate: true));
  });

  /// Same tree as pumpConsumerWidget, pumped by hand because the page spins a progress
  /// indicator while the biometric result is pending and pumpAndSettle would never return.
  /// The completer is made here, inside the test's fake async zone, so completing it reaches
  /// the page on the next pump.
  Future<void> pumpPage(WidgetTester tester) async {
    biometricResult = Completer<PrivateModeBiometricResult>();
    await tester.pumpWidget(
      EasyLocalization(
        supportedLocales: locales.values.toList(),
        path: translationsPath,
        startLocale: locales.values.first,
        fallbackLocale: locales.values.first,
        saveLocale: false,
        useFallbackTranslations: true,
        assetLoader: const CodegenLoader(),
        child: ProviderScope(
          overrides: [
            apiServiceProvider.overrideWithValue(apiService),
            localAuthProvider.overrideWith((ref) => LocalAuthNotifier(localAuth, secureStorage)),
            privateModeProvider.overrideWith((ref) => privateMode = _TestPrivateModeNotifier(ref, biometricResult)),
          ],
          child: Builder(
            builder: (context) => MaterialApp(
              debugShowCheckedModeBanner: false,
              localizationsDelegates: context.localizationDelegates,
              supportedLocales: context.supportedLocales,
              locale: context.locale,
              home: const Material(child: PrivatePinAuthPage()),
            ),
          ),
        ),
      ),
    );
    await pumpFrames(tester);
  }

  testWidgets('tries the biometric enrolment before showing the PIN pad', (tester) async {
    await pumpPage(tester);

    expect(privateMode.biometricAttempts, 1);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.byType(PinVerificationForm), findsNothing);
  });

  testWidgets('falls back to the PIN pad when the user is not enrolled', (tester) async {
    await pumpPage(tester);

    biometricResult.complete(PrivateModeBiometricResult.notEnrolled);
    await pumpFrames(tester);

    expect(find.byType(PinVerificationForm), findsOneWidget);
    expect(find.byType(PinRegistrationForm), findsNothing);
    expect(find.byIcon(Icons.fingerprint), findsOneWidget);
    expect(privateMode.biometricAttempts, 1);
  });

  testWidgets('falls back to the PIN pad when the biometric prompt is cancelled', (tester) async {
    await pumpPage(tester);

    biometricResult.complete(PrivateModeBiometricResult.failed);
    await pumpFrames(tester);

    expect(find.byType(PinVerificationForm), findsOneWidget);
    expect(privateMode.biometricAttempts, 1);
  });

  testWidgets('shows the PIN registration form when the user has no PIN yet', (tester) async {
    when(() => authenticationApi.getAuthStatus()).thenAnswer(
      (_) async => AuthStatusResponseDto(isElevated: false, password: true, pinCode: false, privateMode: false),
    );
    await pumpPage(tester);

    biometricResult.complete(PrivateModeBiometricResult.notEnrolled);
    await pumpFrames(tester);

    expect(find.byType(PinRegistrationForm), findsOneWidget);
    expect(find.byType(PinVerificationForm), findsNothing);
  });
}
