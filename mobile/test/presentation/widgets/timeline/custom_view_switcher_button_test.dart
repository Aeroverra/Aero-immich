import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/domain/services/user.service.dart';
import 'package:immich_mobile/presentation/widgets/timeline/custom_view_switcher_button.widget.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/repositories/custom_view_api.repository.dart';
import 'package:immich_mobile/services/local_auth.service.dart';
import 'package:immich_mobile/services/secure_storage.service.dart';
import 'package:immich_mobile/widgets/forms/pin_verification_form.dart';
import 'package:mocktail/mocktail.dart';

import '../../../service.mocks.dart';
import '../../../test_utils.dart';
import '../../../widget_tester_extensions.dart';

class _MockCustomViewApiRepository extends Mock implements CustomViewApiRepository {}

class _MockUserService extends Mock implements UserService {}

class _TestPrivateModeNotifier extends PrivateModeNotifier {
  _TestPrivateModeNotifier(super.ref, this.initial) {
    state = initial;
  }

  final bool initial;

  @override
  Future<void> refresh() async {}
}

const _me = 'user-1';
const _default = CustomView(id: 'default', ownerId: _me, name: 'Vetted', isDefault: true);
const _open = CustomView(id: 'open', ownerId: _me, name: 'Everything', order: 1);
const _locked = CustomView(id: 'locked', ownerId: _me, name: 'Gym', order: 2, access: ViewAccess.locked);
const _private = CustomView(id: 'private', ownerId: _me, name: 'Hidden', order: 3, access: ViewAccess.private);

void main() {
  late _MockCustomViewApiRepository api;
  late MockSecureStorageService secureStorage;
  late MockLocalAuthService localAuth;

  setUpAll(TestUtils.init);

  setUp(() {
    api = _MockCustomViewApiRepository();
    secureStorage = MockSecureStorageService();
    localAuth = MockLocalAuthService();
    when(
      () => api.setActive(any(), pinCode: any(named: 'pinCode')),
    ).thenAnswer((invocation) async => ActiveCustomView(viewId: invocation.positionalArguments.first as String?));
    when(() => secureStorage.read(kSecuredPinCode)).thenAnswer((_) async => null);
  });

  Future<void> pump(
    WidgetTester tester, {
    bool supported = true,
    List<CustomView> views = const [_default, _open, _locked, _private],
    bool privateMode = false,
  }) {
    final userService = _MockUserService();
    when(
      () => userService.tryGetMyUser(),
    ).thenReturn(UserDto(id: _me, email: 'me@test.dev', name: 'me', profileChangedAt: DateTime(2026)));
    when(() => userService.watchMyUser()).thenAnswer((_) => const Stream.empty());

    return tester.pumpConsumerWidget(
      const CustomViewSwitcherButton(),
      overrides: [
        customViewsSupportedProvider.overrideWithValue(supported),
        currentUserProvider.overrideWith((ref) => CurrentUserProvider(userService)),
        localViewsProvider.overrideWith((ref) => Stream.value(views)),
        localTagsProvider.overrideWith((ref) => Stream.value(const [])),
        privateModeProvider.overrideWith((ref) => _TestPrivateModeNotifier(ref, privateMode)),
        customViewApiRepositoryProvider.overrideWithValue(api),
        secureStorageServiceProvider.overrideWithValue(secureStorage),
        localAuthServiceProvider.overrideWithValue(localAuth),
      ],
    );
  }

  Future<void> open(WidgetTester tester) async {
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('custom-view-switcher')));
    await tester.pumpAndSettle();
  }

  testWidgets('is hidden for servers without custom views', (tester) async {
    await pump(tester, supported: false);
    await tester.pumpAndSettle();

    expect(find.byType(IconButton), findsNothing);
  });

  testWidgets('is hidden while the user has no views', (tester) async {
    await pump(tester, views: const []);
    await tester.pumpAndSettle();

    expect(find.byType(IconButton), findsNothing);
  });

  testWidgets('lists the default, open and locked views, private views only in private mode', (tester) async {
    await pump(tester);
    await open(tester);

    expect(find.text('Vetted'), findsOneWidget);
    expect(find.text('Everything'), findsOneWidget);
    expect(find.text('Gym'), findsOneWidget);
    expect(find.text('Hidden'), findsNothing);
    expect(
      find.descendant(
        of: find.byKey(const Key('custom-view-locked')),
        matching: find.byIcon(Icons.lock_outline_rounded),
      ),
      findsOneWidget,
    );
    // the default view is the applied one
    expect(
      find.descendant(of: find.byKey(const Key('custom-view-default')), matching: find.byIcon(Icons.check_rounded)),
      findsOneWidget,
    );
  });

  testWidgets('private mode lists private views', (tester) async {
    await pump(tester, privateMode: true);
    await open(tester);

    expect(find.text('Hidden'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const Key('custom-view-private')),
        matching: find.byIcon(Icons.lock_person_outlined),
      ),
      findsOneWidget,
    );
  });

  testWidgets('an open view switches right away', (tester) async {
    await pump(tester);
    await open(tester);

    await tester.tap(find.text('Everything'));
    await tester.pumpAndSettle();

    verify(() => api.setActive('open')).called(1);
    expect(find.byType(BottomSheet), findsNothing);
    expect(tester.widget<IconButton>(find.byType(IconButton)).isSelected, isTrue);
  });

  testWidgets('a locked view asks for the PIN code when biometrics are not enrolled', (tester) async {
    await pump(tester);
    await open(tester);

    await tester.tap(find.text('Gym'));
    // the PIN field cursor keeps animating
    for (int i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }

    expect(find.byType(PinVerificationForm), findsOneWidget);
    expect(find.text('Switch to Gym'), findsOneWidget);
    verifyNever(() => api.setActive('locked', pinCode: any(named: 'pinCode')));
  });

  testWidgets('a locked view switches with biometrics without asking for the PIN code', (tester) async {
    when(() => secureStorage.read(kSecuredPinCode)).thenAnswer((_) async => '123456');
    when(() => localAuth.authenticate()).thenAnswer((_) async => true);
    await pump(tester);
    await open(tester);

    await tester.tap(find.text('Gym'));
    await tester.pumpAndSettle();

    expect(find.byType(PinVerificationForm), findsNothing);
    verify(() => api.setActive('locked', pinCode: '123456')).called(1);
  });
}
