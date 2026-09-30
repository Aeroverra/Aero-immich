import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';
import 'package:immich_mobile/widgets/settings/previously_deleted_settings/previously_deleted_settings.dart';
import 'package:mocktail/mocktail.dart';

import '../../repository.mocks.dart';
import '../../test_utils.dart';
import '../../widget_tester_extensions.dart';

void main() {
  late MockUserApiRepository repository;

  setUpAll(() {
    TestUtils.init();
    registerFallbackValue(DeletedReimportMode.trash);
  });

  setUp(() {
    repository = MockUserApiRepository();
    when(() => repository.getDeletedReimportMode()).thenAnswer((_) async => DeletedReimportMode.album);
    when(() => repository.getDeletedChecksumCount()).thenAnswer((_) async => 3);
    when(() => repository.setDeletedReimportMode(any())).thenAnswer((_) async {});
    when(() => repository.forgetDeletedChecksums()).thenAnswer((_) async {});
  });

  Future<void> pump(WidgetTester tester) => tester.pumpConsumerWidget(
    const PreviouslyDeletedSettings(),
    overrides: [userApiRepositoryProvider.overrideWithValue(repository)],
  );

  DeletedReimportMode? selectedMode(WidgetTester tester) =>
      tester.widget<RadioGroup<DeletedReimportMode>>(find.byType(RadioGroup<DeletedReimportMode>)).groupValue;

  testWidgets('shows the mode and the remembered files from the server', (tester) async {
    await pump(tester);

    expect(selectedMode(tester), DeletedReimportMode.album);
    expect(find.text('3 remembered files'), findsOneWidget);
    expect(find.text('Forget all remembered files (3)'), findsOneWidget);
    verify(() => repository.getDeletedReimportMode()).called(1);
    verify(() => repository.getDeletedChecksumCount()).called(1);
  });

  testWidgets('saves a newly selected mode to the server', (tester) async {
    await pump(tester);

    await tester.tap(find.text('Do not upload it'));
    await tester.pumpAndSettle();

    verify(() => repository.setDeletedReimportMode(DeletedReimportMode.skip)).called(1);
    expect(selectedMode(tester), DeletedReimportMode.skip);
  });

  testWidgets('restores the previous mode when saving fails', (tester) async {
    when(() => repository.setDeletedReimportMode(any())).thenThrow(Exception('offline'));
    await pump(tester);

    await tester.tap(find.text('Do not upload it'));
    await tester.pumpAndSettle();

    expect(selectedMode(tester), DeletedReimportMode.album);
    // let the error toast expire
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('forgets the remembered files after confirmation', (tester) async {
    await pump(tester);

    await tester.tap(find.text('Forget all remembered files (3)'));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsOneWidget);

    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();

    verify(() => repository.forgetDeletedChecksums()).called(1);
    expect(find.text('0 remembered files'), findsOneWidget);
    // let the success toast expire
    await tester.pump(const Duration(seconds: 5));
    final button = tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, 'Forget all remembered files (0)'),
    );
    expect(button.enabled, isFalse);
  });

  testWidgets('keeps the remembered files when the confirmation is cancelled', (tester) async {
    await pump(tester);

    await tester.tap(find.text('Forget all remembered files (3)'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    verifyNever(() => repository.forgetDeletedChecksums());
    expect(find.text('3 remembered files'), findsOneWidget);
  });

  testWidgets('disables the forget button when nothing is remembered', (tester) async {
    when(() => repository.getDeletedChecksumCount()).thenAnswer((_) async => 0);
    await pump(tester);

    final button = tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, 'Forget all remembered files (0)'),
    );
    expect(button.enabled, isFalse);
  });
}
