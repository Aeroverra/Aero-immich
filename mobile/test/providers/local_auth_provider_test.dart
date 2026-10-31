import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/models/auth/biometric_status.model.dart';
import 'package:immich_mobile/providers/local_auth.provider.dart';
import 'package:mocktail/mocktail.dart';

import '../service.mocks.dart';

/// The biometric enrolment the locked folder and private mode share
void main() {
  const pinCode = '123456';

  late MockLocalAuthService localAuth;
  late MockSecureStorageService secureStorage;
  late LocalAuthNotifier notifier;

  setUp(() {
    localAuth = MockLocalAuthService();
    secureStorage = MockSecureStorageService();
    when(
      () => localAuth.getStatus(),
    ).thenAnswer((_) async => const BiometricStatus(availableBiometrics: [], canAuthenticate: true));
    when(() => secureStorage.write(any(), any())).thenAnswer((_) async {});
    notifier = LocalAuthNotifier(localAuth, secureStorage);
  });

  Future<BuildContext> pumpContext(WidgetTester tester) async {
    late BuildContext context;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (buildContext) {
            context = buildContext;
            return const SizedBox.shrink();
          },
        ),
      ),
    );
    return context;
  }

  testWidgets('a passed biometric check stores the PIN under the shared key', (tester) async {
    when(() => localAuth.authenticate(any())).thenAnswer((_) async => true);
    final context = await pumpContext(tester);

    expect(await notifier.registerBiometric(context, pinCode), isTrue);

    verify(() => secureStorage.write(kSecuredPinCode, pinCode)).called(1);
  });

  testWidgets('a cancelled biometric check stores nothing', (tester) async {
    when(() => localAuth.authenticate(any())).thenAnswer((_) async => false);
    final context = await pumpContext(tester);

    expect(await notifier.registerBiometric(context, pinCode), isFalse);

    verifyNever(() => secureStorage.write(any(), any()));
  });
}
