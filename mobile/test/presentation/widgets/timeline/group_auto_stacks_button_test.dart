import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/domain/services/user.service.dart';
import 'package:immich_mobile/infrastructure/repositories/user_metadata.repository.dart';
import 'package:immich_mobile/models/server_info/server_features.model.dart';
import 'package:immich_mobile/presentation/widgets/timeline/group_auto_stacks_button.widget.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';
import 'package:immich_mobile/providers/server_info.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:mocktail/mocktail.dart';

import '../../../infrastructure/repository.mock.dart';
import '../../../riverpod_mocks.dart';
import '../../../service.mocks.dart';
import '../../../test_utils.dart';
import '../../../widget_tester_extensions.dart';

class _MockUserService extends Mock implements UserService {}

class _MockUserMetadataRepository extends Mock implements UserMetadataRepository {}

void main() {
  const userId = 'user-1';
  const supported = ServerFeatures(map: true, trash: true, oauthEnabled: false, passwordLogin: true, stackSource: true);
  const unsupported = ServerFeatures(map: true, trash: true, oauthEnabled: false, passwordLogin: true);

  late MockUserApiRepository userApi;
  late _MockUserMetadataRepository userMetadata;
  late StreamController<Preferences?> preferences;

  setUpAll(TestUtils.init);

  setUp(() {
    userApi = MockUserApiRepository();
    userMetadata = _MockUserMetadataRepository();
    preferences = StreamController<Preferences?>.broadcast();
    when(() => userApi.updateGroupAutoStacks(any())).thenAnswer((_) async {});
    when(() => userMetadata.watchPreferences(userId)).thenAnswer((_) => preferences.stream);
    when(() => userMetadata.setGroupAutoStacks(userId, any())).thenAnswer((invocation) async {
      preferences.add(Preferences(groupAutoStacks: invocation.positionalArguments[1] as bool));
    });
  });

  tearDown(() async {
    await preferences.close();
  });

  Future<void> pump(WidgetTester tester, {ServerFeatures features = supported}) {
    final userService = _MockUserService();
    final user = UserDto(id: userId, email: 'user@test.dev', name: 'user', profileChangedAt: DateTime(2026));
    when(() => userService.tryGetMyUser()).thenReturn(user);
    when(() => userService.watchMyUser()).thenAnswer((_) => const Stream.empty());
    final drift = MockDrift();
    when(() => drift.userMetadataRepository).thenReturn(userMetadata);

    return tester.pumpConsumerWidget(
      const GroupAutoStacksButton(),
      overrides: [
        serverInfoProvider.overrideWith((ref) => StubServerInfoNotifier(MockServerInfoService(), features: features)),
        currentUserProvider.overrideWith((ref) => CurrentUserProvider(userService)),
        userApiRepositoryProvider.overrideWithValue(userApi),
        driftProvider.overrideWithValue(drift),
      ],
    );
  }

  IconButton button(WidgetTester tester) => tester.widget<IconButton>(find.byType(IconButton));

  testWidgets('is hidden for servers without the stack source', (tester) async {
    await pump(tester, features: unsupported);

    expect(find.byType(IconButton), findsNothing);
  });

  testWidgets('shows the grouped state and offers to show the photos separately', (tester) async {
    await pump(tester);

    expect(button(tester).isSelected, isTrue);
    expect(button(tester).tooltip, 'Show automatic stacks as separate photos');
  });

  testWidgets('toggles the preference with one tap', (tester) async {
    await pump(tester);

    await tester.tap(find.byType(IconButton));
    await tester.pumpAndSettle();

    verify(() => userApi.updateGroupAutoStacks(false)).called(1);
    verify(() => userMetadata.setGroupAutoStacks(userId, false)).called(1);
    expect(button(tester).isSelected, isFalse);
    expect(button(tester).tooltip, 'Group automatic stacks');

    await tester.tap(find.byType(IconButton));
    await tester.pumpAndSettle();

    verify(() => userApi.updateGroupAutoStacks(true)).called(1);
    expect(button(tester).isSelected, isTrue);
  });

  testWidgets('keeps the state when the server rejects the change', (tester) async {
    when(() => userApi.updateGroupAutoStacks(any())).thenThrow(Exception('offline'));
    await pump(tester);

    await tester.tap(find.byType(IconButton));
    await tester.pumpAndSettle();

    verifyNever(() => userMetadata.setGroupAutoStacks(any(), any()));
    expect(button(tester).isSelected, isTrue);
    // let the error toast expire
    await tester.pump(const Duration(seconds: 5));
  });
}
