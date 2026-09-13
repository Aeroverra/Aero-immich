import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/utils/private_share.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../service.mocks.dart';
import '../unit/factories/remote_album_factory.dart';
import '../unit/factories/remote_asset_factory.dart';
import '../unit/presentation/presentation_context.dart';

void main() {
  late PresentationContext context;

  setUp(() async {
    context = await PresentationContext.create();
  });

  tearDown(() async {
    await context.dispose();
  });

  group('privateAddWarning', () {
    final private = RemoteAssetFactory.create(isPrivate: true);
    final public = RemoteAssetFactory.create();
    final t = StaticTranslations.instance;

    Future<BuildContext> pumpContext(WidgetTester tester) async {
      late BuildContext buildContext;
      await tester.pumpTestWidget(
        context,
        Builder(
          builder: (context) {
            buildContext = context;
            return const SizedBox.shrink();
          },
        ),
      );
      return buildContext;
    }

    testWidgets('nothing to acknowledge without a private asset or for an album that is private already', (
      tester,
    ) async {
      final buildContext = await pumpContext(tester);

      expect(privateAddWarning(buildContext, RemoteAlbumFactory.create(isShared: true), [public]), isNull);
      expect(privateAddWarning(buildContext, RemoteAlbumFactory.create(isShared: true), const []), isNull);
      expect(privateAddWarning(buildContext, RemoteAlbumFactory.create(isPrivate: true), [private]), isNull);
    });

    testWidgets('a public album is warned about becoming private and hidden', (tester) async {
      final buildContext = await pumpContext(tester);
      final album = RemoteAlbumFactory.create(name: 'Trip');

      expect(privateAddWarning(buildContext, album, [public, private]), t.add_to_album_private_prompt(album: 'Trip'));
    });

    testWidgets('a private shared album is warned about the share only', (tester) async {
      final buildContext = await pumpContext(tester);
      final album = RemoteAlbumFactory.create(isShared: true, isPrivate: true);

      expect(privateAddWarning(buildContext, album, [private]), t.add_private_assets_to_shared_album_confirmation);
    });

    testWidgets('a public shared album folds both warnings into one text', (tester) async {
      final buildContext = await pumpContext(tester);
      final album = RemoteAlbumFactory.create(name: 'Trip', isShared: true);

      expect(
        privateAddWarning(buildContext, album, [private]),
        '${t.add_to_album_private_prompt(album: 'Trip')}\n\n'
        '${t.add_private_assets_to_shared_album_confirmation}',
      );
    });
  });

  group('isPrivateConfirmationRequired', () {
    test('recognises the server refusal and nothing else', () {
      expect(
        isPrivateConfirmationRequired(
          ApiException(400, '{"message":"Album contains private assets, confirmPrivate is required"}'),
        ),
        isTrue,
      );
      expect(isPrivateConfirmationRequired(ApiException(400, '{"message":"albumName must be a string"}')), isFalse);
      expect(isPrivateConfirmationRequired(ApiException(403, 'confirmPrivate')), isFalse);
      expect(isPrivateConfirmationRequired(StateError('confirmPrivate')), isFalse);
    });
  });

  group('addUsersWithPrivateConfirmation', () {
    late MockRemoteAlbumService albumService;

    setUp(() {
      albumService = context.service.album.service;
      when(
        () => albumService.addUsers(
          albumId: any(named: 'albumId'),
          userIds: any(named: 'userIds'),
          confirmPrivate: any(named: 'confirmPrivate'),
        ),
      ).thenAnswer((_) async {});
    });

    /// Renders a button that adds [userIds] to [album] through the helper and records the outcome
    Future<void> pumpRunner(WidgetTester tester, RemoteAlbum album, void Function(bool added) onDone) =>
        tester.pumpTestWidget(
          context,
          Consumer(
            builder: (context, ref, _) => TextButton(
              onPressed: () async => onDone(await addUsersWithPrivateConfirmation(context, ref, album, ['user-2'])),
              child: const Text('run'),
            ),
          ),
        );

    testWidgets('adds straight away without acknowledgement for a public album', (tester) async {
      final album = RemoteAlbumFactory.create();
      bool? added;
      await pumpRunner(tester, album, (value) => added = value);

      await tester.tap(find.text('run'));
      await tester.pumpAndSettle();

      expect(find.byType(ConfirmDialog), findsNothing);
      expect(added, isTrue);
      verify(() => albumService.addUsers(albumId: album.id, userIds: ['user-2'], confirmPrivate: false)).called(1);
    });

    testWidgets('asks first and forwards the acknowledgement for a private album', (tester) async {
      final album = RemoteAlbumFactory.create(isPrivate: true);
      bool? added;
      await pumpRunner(tester, album, (value) => added = value);

      await tester.tap(find.text('run'));
      await tester.pumpUntilFound(find.byType(ConfirmDialog));
      expect(find.text(StaticTranslations.instance.share_private_album_confirmation), findsOneWidget);
      await tester.tap(find.text(StaticTranslations.instance.confirm));
      await tester.pumpAndSettle();

      expect(added, isTrue);
      verify(() => albumService.addUsers(albumId: album.id, userIds: ['user-2'], confirmPrivate: true)).called(1);
    });

    testWidgets('adds nobody when the user declines to share a private album', (tester) async {
      final album = RemoteAlbumFactory.create(isPrivate: true);
      bool? added;
      await pumpRunner(tester, album, (value) => added = value);

      await tester.tap(find.text('run'));
      await tester.pumpUntilFound(find.byType(ConfirmDialog));
      await tester.tap(find.text(StaticTranslations.instance.cancel));
      await tester.pumpAndSettle();

      expect(added, isFalse);
      verifyNever(
        () => albumService.addUsers(
          albumId: any(named: 'albumId'),
          userIds: any(named: 'userIds'),
          confirmPrivate: any(named: 'confirmPrivate'),
        ),
      );
    });
  });

  group('addWithPrivateShareConfirmation', () {
    final serverRefusal = ApiException(400, '{"message":"Album contains private assets, confirmPrivate is required"}');

    /// Renders a button that runs the helper and records what it returned
    const warning = 'Trip will become private';

    Future<void> pumpRunner(
      WidgetTester tester, {
      required String? warning,
      required Future<String> Function({required bool confirmPrivate}) add,
      required void Function(String? result) onDone,
    }) => tester.pumpTestWidget(
      context,
      Builder(
        builder: (context) => TextButton(
          onPressed: () async => onDone(await addWithPrivateShareConfirmation(context, warning: warning, add: add)),
          child: const Text('run'),
        ),
      ),
    );

    Future<void> answerDialog(WidgetTester tester, {required bool confirm, String? expectedText}) async {
      await tester.pumpUntilFound(find.byType(ConfirmDialog));
      expect(
        find.text(expectedText ?? StaticTranslations.instance.add_private_assets_to_shared_album_confirmation),
        findsOneWidget,
      );
      await tester.tap(find.text(confirm ? StaticTranslations.instance.confirm : StaticTranslations.instance.cancel));
      await tester.pumpAndSettle();
    }

    testWidgets('runs straight away without a dialog when nothing private is shared', (tester) async {
      final calls = <bool>[];
      String? result;
      await pumpRunner(
        tester,
        warning: null,
        add: ({required confirmPrivate}) async {
          calls.add(confirmPrivate);
          return 'added';
        },
        onDone: (value) => result = value,
      );

      await tester.tap(find.text('run'));
      await tester.pumpAndSettle();

      expect(find.byType(ConfirmDialog), findsNothing);
      expect(calls, [false]);
      expect(result, 'added');
    });

    testWidgets('shows the warning first and forwards confirmPrivate once acknowledged', (tester) async {
      final calls = <bool>[];
      String? result;
      await pumpRunner(
        tester,
        warning: warning,
        add: ({required confirmPrivate}) async {
          calls.add(confirmPrivate);
          return 'added';
        },
        onDone: (value) => result = value,
      );

      await tester.tap(find.text('run'));
      await answerDialog(tester, confirm: true, expectedText: warning);

      expect(calls, [true]);
      expect(result, 'added');
    });

    testWidgets('adds nothing when the user declines up front', (tester) async {
      final calls = <bool>[];
      String? result = 'untouched';
      await pumpRunner(
        tester,
        warning: warning,
        add: ({required confirmPrivate}) async {
          calls.add(confirmPrivate);
          return 'added';
        },
        onDone: (value) => result = value,
      );

      await tester.tap(find.text('run'));
      await answerDialog(tester, confirm: false, expectedText: warning);

      expect(calls, isEmpty);
      expect(result, isNull);
    });

    testWidgets('asks and retries with confirmPrivate when only the server knew the album is shared', (tester) async {
      final calls = <bool>[];
      String? result;
      await pumpRunner(
        tester,
        warning: null,
        add: ({required confirmPrivate}) async {
          calls.add(confirmPrivate);
          if (!confirmPrivate) {
            throw serverRefusal;
          }
          return 'added';
        },
        onDone: (value) => result = value,
      );

      await tester.tap(find.text('run'));
      await answerDialog(tester, confirm: true);

      expect(calls, [false, true]);
      expect(result, 'added');
    });

    testWidgets('does not retry when the user declines the server prompted confirmation', (tester) async {
      final calls = <bool>[];
      String? result = 'untouched';
      await pumpRunner(
        tester,
        warning: null,
        add: ({required confirmPrivate}) async {
          calls.add(confirmPrivate);
          throw serverRefusal;
        },
        onDone: (value) => result = value,
      );

      await tester.tap(find.text('run'));
      await answerDialog(tester, confirm: false);

      expect(calls, [false]);
      expect(result, isNull);
    });

    testWidgets('any other failure is rethrown untouched', (tester) async {
      late BuildContext buildContext;
      await tester.pumpTestWidget(
        context,
        Builder(
          builder: (context) {
            buildContext = context;
            return const SizedBox.shrink();
          },
        ),
      );

      await expectLater(
        addWithPrivateShareConfirmation(
          buildContext,
          warning: null,
          add: ({required confirmPrivate}) async => throw ApiException(500, 'boom'),
        ),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 500)),
      );
      await tester.pump();
      expect(find.byType(ConfirmDialog), findsNothing);
    });
  });
}
