import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';
import 'package:immich_mobile/widgets/settings/asset_list_settings/asset_list_auto_stack_settings.dart';
import 'package:mocktail/mocktail.dart';

import '../../infrastructure/repository.mock.dart';
import '../../test_utils.dart';
import '../../widget_tester_extensions.dart';

void main() {
  late MockUserApiRepository userApi;

  setUpAll(TestUtils.init);

  setUp(() {
    userApi = MockUserApiRepository();
    when(() => userApi.getAutoStackEnabled()).thenAnswer((_) async => false);
    when(() => userApi.updateAutoStackEnabled(any())).thenAnswer((_) async {});
  });

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpConsumerWidget(
      const AutoStackSettings(),
      overrides: [userApiRepositoryProvider.overrideWithValue(userApi)],
    );
    await tester.pumpAndSettle();
  }

  bool switchValue(WidgetTester tester) => tester.widget<Switch>(find.byType(Switch)).value;

  testWidgets('is hidden for servers without automatic stacks', (tester) async {
    when(() => userApi.getAutoStackEnabled()).thenAnswer((_) async => null);
    await pump(tester);

    expect(find.byType(Switch), findsNothing);
  });

  testWidgets('is hidden when the preference cannot be loaded', (tester) async {
    when(() => userApi.getAutoStackEnabled()).thenThrow(Exception('offline'));
    await pump(tester);

    expect(find.byType(Switch), findsNothing);
  });

  testWidgets('shows the preference of the server', (tester) async {
    when(() => userApi.getAutoStackEnabled()).thenAnswer((_) async => true);
    await pump(tester);

    expect(find.text('Stack similar photos automatically'), findsOneWidget);
    expect(switchValue(tester), isTrue);
  });

  testWidgets('saves the change on the server', (tester) async {
    await pump(tester);

    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();

    verify(() => userApi.updateAutoStackEnabled(true)).called(1);
    expect(switchValue(tester), isTrue);
  });

  testWidgets('switches back when the server rejects the change', (tester) async {
    when(() => userApi.updateAutoStackEnabled(any())).thenThrow(Exception('offline'));
    await pump(tester);

    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();

    expect(switchValue(tester), isFalse);
    // let the error toast expire
    await tester.pump(const Duration(seconds: 5));
  });
}
