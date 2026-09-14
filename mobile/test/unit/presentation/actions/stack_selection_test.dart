import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/infrastructure/repositories/user_metadata.repository.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/presentation/actions/action.widget.dart';
import 'package:immich_mobile/presentation/actions/delete.action.dart';
import 'package:immich_mobile/presentation/actions/favorite.action.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';
import 'package:immich_mobile/utils/option.dart';
import 'package:immich_mobile/utils/stack_selection.dart';
import 'package:immich_ui/immich_ui.dart';
import 'package:mocktail/mocktail.dart';

import '../../../infrastructure/repository.mock.dart';
import '../../../service.mocks.dart';
import '../../factories/remote_asset_factory.dart';
import '../presentation_context.dart';

class _MockUserMetadataRepository extends Mock implements UserMetadataRepository {}

void main() {
  late PresentationContext context;
  late MockAssetService assetService;
  late MockDrift drift;
  late MockRemoteAssetRepository remoteAssetRepository;
  late _MockUserMetadataRepository userMetadataRepository;
  late MockUserApiRepository userApiRepository;

  late RemoteAsset primary;
  late RemoteAsset member;
  late RemoteAsset plain;

  setUpAll(() {
    registerFallbackValue(StackActionMode.ask);
  });

  setUp(() async {
    context = await PresentationContext.create();
    assetService = context.service.asset.service;
    drift = MockDrift();
    remoteAssetRepository = MockRemoteAssetRepository();
    userMetadataRepository = _MockUserMetadataRepository();
    userApiRepository = MockUserApiRepository();
    when(() => drift.remoteAssetRepository).thenReturn(remoteAssetRepository);
    when(() => drift.userMetadataRepository).thenReturn(userMetadataRepository);
    when(() => userApiRepository.setStackActionMode(any())).thenAnswer((_) async {});
    when(() => userMetadataRepository.setStackActionMode(any(), any())).thenAnswer((_) async {});
    when(() => userMetadataRepository.getStackActionMode(any())).thenAnswer((_) async => StackActionMode.ask);

    primary = RemoteAssetFactory.create(ownerId: context.currentUser.id, stackId: 'stack-1');
    member = RemoteAssetFactory.create(ownerId: context.currentUser.id, stackId: 'stack-1');
    plain = RemoteAssetFactory.create(ownerId: context.currentUser.id);
    when(() => remoteAssetRepository.getStackAssets(any())).thenAnswer((_) async => [primary, member]);
  });

  tearDown(() async {
    await context.dispose();
  });

  List<Override> overrides(Set<BaseAsset> selection) => [
    ...context.selected(selection),
    driftProvider.overrideWithValue(drift),
    userApiRepositoryProvider.overrideWithValue(userApiRepository),
  ];

  Future<void> tapAction(WidgetTester tester, ActionBuilder action, Set<BaseAsset> selection) async {
    await tester.pumpTestWidget(context, ActionIconButton(action: action), overrides: overrides(selection));
    await tester.tap(find.byType(ImmichIconButton));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  group('stack selection', () {
    testWidgets('asks when a selected stack hides assets and includes them when told to', (tester) async {
      await tapAction(tester, const FavoriteAction(source: .timeline), {primary, plain});

      expect(find.byType(StackSelectionDialog), findsOneWidget);
      await tester.tap(find.text('Include stacked items'));
      await tester.pumpAndSettle();

      verify(
        () => assetService.update([primary.id, plain.id, member.id], isFavorite: const Option.some(true)),
      ).called(1);
      verifyNever(() => userApiRepository.setStackActionMode(any()));
    });

    testWidgets('keeps the top items only when told to', (tester) async {
      await tapAction(tester, const FavoriteAction(source: .timeline), {primary, plain});

      await tester.tap(find.text('Top items only'));
      await tester.pumpAndSettle();

      verify(() => assetService.update([primary.id, plain.id], isFavorite: const Option.some(true))).called(1);
    });

    testWidgets('does nothing when the dialog is cancelled', (tester) async {
      await tapAction(tester, const FavoriteAction(source: .timeline), {primary});

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      verifyNever(() => assetService.update(any(), isFavorite: any(named: 'isFavorite')));
    });

    testWidgets('remembers the choice on the server and locally', (tester) async {
      await tapAction(tester, const FavoriteAction(source: .timeline), {primary});

      await tester.tap(find.byType(CheckboxListTile));
      await tester.pump();
      await tester.tap(find.text('Include stacked items'));
      await tester.pumpAndSettle();

      verify(() => userApiRepository.setStackActionMode(StackActionMode.stack)).called(1);
      verify(() => userMetadataRepository.setStackActionMode(context.currentUser.id, StackActionMode.stack)).called(1);
      verify(() => assetService.update([primary.id, member.id], isFavorite: const Option.some(true))).called(1);
    });

    testWidgets('uses a remembered choice without asking', (tester) async {
      when(() => userMetadataRepository.getStackActionMode(any())).thenAnswer((_) async => StackActionMode.stack);

      await tapAction(tester, const FavoriteAction(source: .timeline), {primary});

      expect(find.byType(StackSelectionDialog), findsNothing);
      verify(() => assetService.update([primary.id, member.id], isFavorite: const Option.some(true))).called(1);
    });

    testWidgets('does not ask when every stacked asset is already selected', (tester) async {
      await tapAction(tester, const FavoriteAction(source: .timeline), {primary, member});

      expect(find.byType(StackSelectionDialog), findsNothing);
      verify(() => assetService.update([primary.id, member.id], isFavorite: const Option.some(true))).called(1);
    });

    testWidgets('trashes and restores the stacked assets with the selection', (tester) async {
      await tapAction(tester, const DeleteAction(source: .timeline), {primary});

      await tester.tap(find.text('Include stacked items'));
      await tester.pumpAndSettle();
      verify(() => assetService.trash([primary.id, member.id])).called(1);

      await tester.tap(find.text('Undo'));
      await tester.pump();
      verify(() => assetService.restoreTrash([primary.id, member.id])).called(1);
    });
  });
}
