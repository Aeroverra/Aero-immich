import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/presentation/actions/action.widget.dart';
import 'package:immich_mobile/presentation/actions/private.action.dart';
import 'package:immich_ui/immich_ui.dart';
import 'package:mocktail/mocktail.dart';

import '../../../service.mocks.dart';
import '../../factories/remote_asset_factory.dart';
import '../presentation_context.dart';

void main() {
  late PresentationContext context;
  late MockAssetService assetService;

  setUp(() async {
    context = await PresentationContext.create();
    assetService = context.service.asset.service;
  });

  tearDown(() async {
    await context.dispose();
  });

  RemoteAsset owned({bool isPrivate = false}) =>
      RemoteAssetFactory.create(ownerId: context.currentUser.id, isPrivate: isPrivate);

  /// Renders both builders side by side, the way the timeline bottom sheet lists them
  Future<void> pumpBoth(WidgetTester tester, Set<BaseAsset> selection) => tester.pumpTestWidget(
    context,
    const Column(
      children: [
        ActionIconButton(action: MarkPrivateAction(source: .timeline)),
        ActionIconButton(action: UnmarkPrivateAction(source: .timeline)),
      ],
    ),
    overrides: context.selected(selection),
  );

  Finder button(IconData icon) => find.byWidgetPredicate((w) => w is ImmichIconButton && w.icon == icon);
  final markButton = button(Icons.lock_person_outlined);
  final unmarkButton = button(Icons.lock_open_rounded);

  group('visibility', () {
    testWidgets('mark is offered with the mode off, unmark is not', (tester) async {
      context.privateMode = false;

      await pumpBoth(tester, {owned(), owned(isPrivate: true)});

      expect(markButton, findsOneWidget);
      expect(unmarkButton, findsNothing);
    });

    testWidgets('a mixed selection offers both once the mode is on', (tester) async {
      context.privateMode = true;

      await pumpBoth(tester, {owned(), owned(isPrivate: true)});

      expect(markButton, findsOneWidget);
      expect(unmarkButton, findsOneWidget);
    });

    testWidgets('only unmark for an all private selection', (tester) async {
      context.privateMode = true;

      await pumpBoth(tester, {owned(isPrivate: true)});

      expect(markButton, findsNothing);
      expect(unmarkButton, findsOneWidget);
    });

    testWidgets('only mark for an all public selection', (tester) async {
      context.privateMode = true;

      await pumpBoth(tester, {owned()});

      expect(markButton, findsOneWidget);
      expect(unmarkButton, findsNothing);
    });

    testWidgets('inside the private folder only unmark is offered', (tester) async {
      context.privateMode = true;
      context.inPrivateView = true;

      await pumpBoth(tester, {owned(), owned(isPrivate: true)});

      expect(markButton, findsNothing);
      expect(unmarkButton, findsOneWidget);
    });

    testWidgets('neither is offered for assets owned by someone else', (tester) async {
      context.privateMode = true;

      await pumpBoth(tester, {RemoteAssetFactory.create(), RemoteAssetFactory.create(isPrivate: true)});

      expect(markButton, findsNothing);
      expect(unmarkButton, findsNothing);
    });
  });

  group('MarkPrivateAction', () {
    testWidgets('marks the owned public assets while the mode is off', (tester) async {
      final public = owned();
      final private = owned(isPrivate: true);

      await tester.pumpTestAction(
        context,
        const MarkPrivateAction(source: .timeline),
        overrides: context.selected({public, private}),
      );

      verify(() => assetService.update([public.id], isPrivate: const .some(true))).called(1);
    });

    testWidgets('offers no undo while the mode is off, unmarking needs the mode', (tester) async {
      await tester.pumpTestAction(
        context,
        const MarkPrivateAction(source: .timeline),
        overrides: context.selected({owned()}),
      );
      await tester.pumpAndSettle();

      expect(find.byType(SnackBar), findsOneWidget);
      expect(find.text('Undo'), findsNothing);
    });

    testWidgets('offers an undo that removes the flag again while the mode is on', (tester) async {
      context.privateMode = true;
      final asset = owned();

      await tester.pumpTestAction(
        context,
        const MarkPrivateAction(source: .timeline),
        overrides: context.selected({asset}),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Undo'));
      await tester.pump();

      verify(() => assetService.update([asset.id], isPrivate: const .some(false))).called(1);
    });

    testWidgets('clears the selection once the update succeeds', (tester) async {
      await tester.pumpTestAction(
        context,
        const MarkPrivateAction(source: .timeline),
        overrides: context.selected({owned()}),
      );
      await tester.pumpAndSettle();

      expect(find.byType(ImmichIconButton), findsNothing, reason: 'an empty selection hides the action');
    });
  });

  group('UnmarkPrivateAction', () {
    testWidgets('removes the flag from the owned private assets', (tester) async {
      context.privateMode = true;
      final public = owned();
      final private = owned(isPrivate: true);

      await tester.pumpTestAction(
        context,
        const UnmarkPrivateAction(source: .timeline),
        overrides: context.selected({public, private}),
      );

      verify(() => assetService.update([private.id], isPrivate: const .some(false))).called(1);
    });

    testWidgets('offers an undo that marks the assets private again', (tester) async {
      context.privateMode = true;
      final asset = owned(isPrivate: true);

      await tester.pumpTestAction(
        context,
        const UnmarkPrivateAction(source: .timeline),
        overrides: context.selected({asset}),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Undo'));
      await tester.pump();

      verify(() => assetService.update([asset.id], isPrivate: const .some(true))).called(1);
    });
  });
}
