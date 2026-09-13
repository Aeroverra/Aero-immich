import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.widget.dart';
import 'package:immich_mobile/presentation/actions/private.action.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';
import 'package:immich_ui/immich_ui.dart';
import 'package:mocktail/mocktail.dart';

import '../../../service.mocks.dart';
import '../../factories/remote_album_factory.dart';
import '../../factories/remote_asset_factory.dart';
import '../../mocks.dart';
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

  group('MarkPrivateAction album warning', () {
    late MockRemoteAlbumService albumService;
    late RemoteAlbumServiceStub albumStub;
    final t = StaticTranslations.instance;

    setUp(() {
      albumStub = context.service.album;
      albumService = albumStub.service;
    });

    Future<void> pumpMark(WidgetTester tester, Set<BaseAsset> selection) => tester.pumpTestAction(
      context,
      const MarkPrivateAction(source: .timeline),
      overrides: context.selected(selection),
    );

    testWidgets('marks straight away when the assets are in no album', (tester) async {
      final asset = owned();

      await pumpMark(tester, {asset});
      await tester.pumpAndSettle();

      expect(find.byType(ConfirmDialog), findsNothing);
      verify(() => albumService.getAlbumsContainingAssets([asset.id], privateFilter: any(named: 'privateFilter')));
      verify(() => assetService.update([asset.id], isPrivate: const .some(true))).called(1);
    });

    testWidgets('lists the public albums the assets are in, flagging the shared ones', (tester) async {
      when(albumStub.getAlbumsContainingAssets).thenAnswer(
        (_) async => [
          RemoteAlbumFactory.create(name: 'Trip'),
          RemoteAlbumFactory.create(name: 'Family', isShared: true),
          RemoteAlbumFactory.create(name: 'Secrets', isPrivate: true),
        ],
      );

      await pumpMark(tester, {owned()});
      await tester.pumpUntilFound(find.byType(ConfirmDialog));

      expect(find.text(t.mark_private_albums_title), findsOneWidget);
      expect(find.text(t.mark_private_albums_description(count: 2)), findsOneWidget);
      expect(find.text('Trip'), findsOneWidget);
      expect(find.text('Family'), findsOneWidget);
      expect(find.text('Secrets'), findsNothing, reason: 'an album that is private already does not change');
      expect(find.text(t.shared), findsOneWidget);
      expect(find.text(t.mark_private_remove_from_albums), findsOneWidget);
      expect(find.text(t.mark_private_keep_albums), findsOneWidget);
    });

    testWidgets('cancel leaves the assets and the albums alone', (tester) async {
      when(albumStub.getAlbumsContainingAssets).thenAnswer((_) async => [RemoteAlbumFactory.create()]);

      await pumpMark(tester, {owned()});
      await tester.pumpUntilFound(find.byType(ConfirmDialog));
      await tester.tap(find.text(t.cancel));
      await tester.pumpAndSettle();

      verifyNever(() => assetService.update(any(), isPrivate: any(named: 'isPrivate')));
      verifyNever(albumStub.removeAssets);
    });

    testWidgets('confirming marks private and lets the albums turn private', (tester) async {
      final asset = owned();
      when(albumStub.getAlbumsContainingAssets).thenAnswer((_) async => [RemoteAlbumFactory.create()]);

      await pumpMark(tester, {asset});
      await tester.pumpUntilFound(find.byType(ConfirmDialog));
      await tester.tap(find.text(t.mark_private_keep_albums));
      await tester.pumpAndSettle();

      verify(() => assetService.update([asset.id], isPrivate: const .some(true))).called(1);
      verifyNever(albumStub.removeAssets);
    });

    testWidgets('with the checkbox on the assets leave every listed album before turning private', (tester) async {
      final asset = owned();
      final trip = RemoteAlbumFactory.create(name: 'Trip');
      final family = RemoteAlbumFactory.create(name: 'Family', isShared: true);
      when(albumStub.getAlbumsContainingAssets).thenAnswer((_) async => [trip, family]);

      await pumpMark(tester, {asset});
      await tester.pumpUntilFound(find.byType(ConfirmDialog));
      await tester.tap(find.text(t.mark_private_remove_from_albums));
      await tester.pump(const Duration(milliseconds: 500));
      await tester.tap(find.text(t.mark_private_keep_albums));
      await tester.pumpAndSettle();

      verifyInOrder([
        () => albumService.removeAssets(albumId: trip.id, assetIds: [asset.id]),
        () => albumService.removeAssets(albumId: family.id, assetIds: [asset.id]),
        () => assetService.update([asset.id], isPrivate: const .some(true)),
      ]);
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
