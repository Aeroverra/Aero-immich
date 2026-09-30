import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/infrastructure/repositories/user_metadata.repository.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/widgets/settings/stack_actions_settings/stack_actions_settings.dart';
import 'package:mocktail/mocktail.dart';

import '../../infrastructure/repository.mock.dart';
import '../../test_utils.dart';
import '../../unit/factories/user_factory.dart';
import '../../widget_tester_extensions.dart';

class _MockUserMetadataRepository extends Mock implements UserMetadataRepository {}

void main() {
  late MockUserApiRepository userApiRepository;
  late _MockUserMetadataRepository userMetadataRepository;
  late MockDrift drift;
  late UserDto user;

  setUpAll(() {
    TestUtils.init();
    registerFallbackValue(StackActionMode.ask);
  });

  setUp(() {
    user = UserFactory.createDto();
    userApiRepository = MockUserApiRepository();
    userMetadataRepository = _MockUserMetadataRepository();
    drift = MockDrift();
    when(() => drift.userMetadataRepository).thenReturn(userMetadataRepository);
    when(() => userMetadataRepository.getStackActionMode(any())).thenAnswer((_) async => StackActionMode.primary);
    when(() => userMetadataRepository.setStackActionMode(any(), any())).thenAnswer((_) async {});
    when(() => userApiRepository.setStackActionMode(any())).thenAnswer((_) async {});
  });

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpConsumerWidget(
      const StackActionsSettings(),
      overrides: [
        userApiRepositoryProvider.overrideWithValue(userApiRepository),
        driftProvider.overrideWithValue(drift),
        authUserProvider.overrideWithValue(user),
      ],
    );
    await tester.pumpAndSettle();
  }

  StackActionMode? selectedMode(WidgetTester tester) =>
      tester.widget<RadioGroup<StackActionMode>>(find.byType(RadioGroup<StackActionMode>)).groupValue;

  testWidgets('shows the synced mode', (tester) async {
    await pump(tester);

    expect(selectedMode(tester), StackActionMode.primary);
    expect(find.text('Ask every time'), findsOneWidget);
    expect(find.text('Include stacked items'), findsOneWidget);
    verify(() => userMetadataRepository.getStackActionMode(user.id)).called(1);
  });

  testWidgets('saves a newly selected mode on the server and locally', (tester) async {
    await pump(tester);

    await tester.tap(find.text('Ask every time'));
    await tester.pumpAndSettle();

    verify(() => userApiRepository.setStackActionMode(StackActionMode.ask)).called(1);
    verify(() => userMetadataRepository.setStackActionMode(user.id, StackActionMode.ask)).called(1);
    expect(selectedMode(tester), StackActionMode.ask);
  });

  testWidgets('restores the previous mode when saving fails', (tester) async {
    when(() => userApiRepository.setStackActionMode(any())).thenThrow(Exception('offline'));
    await pump(tester);

    await tester.tap(find.text('Include stacked items'));
    await tester.pumpAndSettle();

    expect(selectedMode(tester), StackActionMode.primary);
    verifyNever(() => userMetadataRepository.setStackActionMode(any(), any()));
    // let the error toast expire
    await tester.pump(const Duration(seconds: 5));
  });
}
