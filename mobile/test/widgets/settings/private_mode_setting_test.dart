import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/widgets/settings/preference_settings/private_mode_setting.dart';
import 'package:mocktail/mocktail.dart';

import '../../infrastructure/repository.mock.dart';
import '../../test_utils.dart';
import '../../widget_tester_extensions.dart';

void main() {
  late MockUserApiRepository api;

  setUpAll(TestUtils.init);

  setUp(() {
    api = MockUserApiRepository();
    when(() => api.getPrivateModeTimeout()).thenAnswer((_) async => 30);
  });

  Future<void> pump(WidgetTester tester, {LockTrigger trigger = LockTrigger.appPause}) async {
    await tester.pumpConsumerWidget(
      const SingleChildScrollView(child: PrivateModeSetting()),
      overrides: [
        userApiRepositoryProvider.overrideWithValue(api),
        privateModeLockTriggerProvider.overrideWithValue(trigger),
      ],
    );
    await tester.pumpAndSettle();
  }

  testWidgets('offers the three lock triggers next to the timeout', (tester) async {
    await pump(tester);
    final t = Translations.of(tester.element(find.byType(PrivateModeSetting)));

    expect(find.text(t.private_mode_timeout), findsOneWidget);
    expect(find.text(t.private_mode_lock_trigger), findsOneWidget);
    expect(find.text(t.lock_trigger_app_pause), findsOneWidget);
    expect(find.text(t.lock_trigger_screen_off), findsOneWidget);
    expect(find.text(t.lock_trigger_timeout), findsOneWidget);
  });

  testWidgets('leaving the app is the picked trigger by default', (tester) async {
    await pump(tester);

    final group = tester.widget<RadioGroup<LockTrigger>>(find.byType(RadioGroup<LockTrigger>));
    expect(group.groupValue, LockTrigger.appPause);
  });

  testWidgets('shows the trigger the user picked', (tester) async {
    await pump(tester, trigger: LockTrigger.timeout);

    final group = tester.widget<RadioGroup<LockTrigger>>(find.byType(RadioGroup<LockTrigger>));
    expect(group.groupValue, LockTrigger.timeout);
  });
}
