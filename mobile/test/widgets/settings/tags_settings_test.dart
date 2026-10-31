import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/tagging.provider.dart';
import 'package:immich_mobile/widgets/settings/tags_settings.dart';
import 'package:mocktail/mocktail.dart';

import '../../test_utils.dart';
import '../../widget_tester_extensions.dart';

class _MockTaggingService extends Mock implements TaggingService {}

class _TestPrivateModeNotifier extends PrivateModeNotifier {
  _TestPrivateModeNotifier(super.ref, bool enabled) {
    state = enabled;
  }

  @override
  Future<void> refresh() async {}
}

const _me = 'user-1';
const _gym = TagEntry(id: 'gym', ownerId: _me, value: 'Gym');
const _progress = TagEntry(id: 'progress', ownerId: _me, value: 'Gym/Progress', parentId: 'gym');
const _secret = TagEntry(id: 'secret', ownerId: _me, value: 'Secret', isHidden: true);
const _vetted = CustomView(id: 'vetted', ownerId: '', name: 'Vetted', isDefault: true, excludeTagIds: ['gym']);

void main() {
  late _MockTaggingService tagging;

  setUpAll(() {
    TestUtils.init();
    registerFallbackValue(_gym);
  });

  setUp(() {
    tagging = _MockTaggingService();
  });

  Future<Translations> pump(
    WidgetTester tester, {
    required bool privateMode,
    List<TagEntry> tags = const [_gym, _progress],
    Set<String> hidden = const {},
  }) async {
    await tester.pumpConsumerWidget(
      const Scaffold(body: TagsSettings()),
      overrides: [
        privateModeProvider.overrideWith((ref) => _TestPrivateModeNotifier(ref, privateMode)),
        taggingServiceProvider.overrideWithValue(tagging),
        tagTreeProvider.overrideWithValue(buildTagTree(tags)),
        effectiveHiddenTagIdsProvider.overrideWithValue(hidden),
      ],
    );
    await tester.pumpAndSettle();
    return Translations.of(tester.element(find.byType(TagsSettings)));
  }

  Future<void> openTag(WidgetTester tester, String id) async {
    await tester.tap(find.byKey(Key('tag-setting-$id')));
    await tester.pumpAndSettle();
  }

  testWidgets('the list has no switches, explains review and marks hidden tags', (tester) async {
    final t = await pump(tester, privateMode: true, tags: const [_gym, _progress, _secret], hidden: const {'secret'});

    expect(find.byType(Switch), findsNothing);
    expect(find.text(t.tag_review), findsOneWidget);
    expect(find.text(t.tag_review_description), findsOneWidget);
    expect(find.text('Gym'), findsOneWidget);
    expect(find.text('Progress'), findsOneWidget);
    expect(find.byKey(const Key('tag-hidden-icon-secret')), findsOneWidget);
    expect(find.byKey(const Key('tag-hidden-icon-gym')), findsNothing);
    expect(find.text(t.tag_name_hidden_marker), findsOneWidget);
  });

  testWidgets('the hide switch is labeled and explains that photos are not changed', (tester) async {
    final t = await pump(tester, privateMode: true);
    await openTag(tester, 'gym');

    final tile = tester.widget<SwitchListTile>(find.byKey(const Key('tag-hide-switch')));
    expect((tile.title! as Text).data, t.tag_hide_name);
    expect((tile.subtitle! as Text).data, t.tag_hide_name_description);
    expect(t.tag_hide_name_description, contains('Photos are not changed'));
    expect(tile.value, isFalse);
  });

  testWidgets('hiding while private mode is locked asks first, then closes with a clear message', (tester) async {
    when(() => tagging.setHidden(any(), any())).thenAnswer((_) async {});
    final t = await pump(tester, privateMode: false);
    await openTag(tester, 'gym');

    await tester.tap(find.byKey(const Key('tag-hide-switch')));
    await tester.pumpAndSettle();
    expect(find.text(t.tag_hide_confirm_title), findsOneWidget);
    await tester.tap(find.text(t.cancel));
    await tester.pumpAndSettle();
    verifyNever(() => tagging.setHidden(any(), any()));

    await tester.tap(find.byKey(const Key('tag-hide-switch')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('tag-hide-confirm')));
    await tester.pumpAndSettle();

    verify(() => tagging.setHidden(_gym, true)).called(1);
    expect(find.byKey(const Key('tag-hide-switch')), findsNothing);
    expect(find.text(t.tag_hidden_snackbar(tag: 'Gym')), findsOneWidget);
    expect(find.text(t.scaffold_body_error_occurred), findsNothing);
  });

  testWidgets('hiding while unlocked needs no confirmation and keeps the sheet open', (tester) async {
    when(() => tagging.setHidden(any(), any())).thenAnswer((_) async {});
    final t = await pump(tester, privateMode: true);
    await openTag(tester, 'gym');

    await tester.tap(find.byKey(const Key('tag-hide-switch')));
    await tester.pumpAndSettle();

    expect(find.text(t.tag_hide_confirm_title), findsNothing);
    verify(() => tagging.setHidden(_gym, true)).called(1);
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('tag-hide-switch'))).value, isTrue);
    expect(find.text(t.tag_name_hidden_snackbar(tag: 'Gym')), findsOneWidget);
  });

  // the cause of the "Error occurred" toast: the unlabeled switch only moved after the server answered, a second tap
  // sent the request again for a tag that was hidden by then, and hidden tags do not exist while private mode is locked
  testWidgets('a second tap while the request runs does not send it again', (tester) async {
    final request = Completer<void>();
    when(() => tagging.setHidden(any(), any())).thenAnswer((_) => request.future);
    await pump(tester, privateMode: true);
    await openTag(tester, 'gym');

    await tester.tap(find.byKey(const Key('tag-hide-switch')));
    await tester.pump();
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('tag-hide-switch'))).onChanged, isNull);
    await tester.tap(find.byKey(const Key('tag-hide-switch')));
    await tester.pump();

    request.complete();
    await tester.pumpAndSettle();
    verify(() => tagging.setHidden(_gym, true)).called(1);
  });

  testWidgets('a failed request names the tag and says nothing changed', (tester) async {
    when(() => tagging.setHidden(any(), any())).thenThrow(Exception('400'));
    final t = await pump(tester, privateMode: true);
    await openTag(tester, 'gym');

    await tester.tap(find.byKey(const Key('tag-hide-switch')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.text(t.tag_update_failed(tag: 'Gym')), findsOneWidget);
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('tag-hide-switch'))).value, isFalse);
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });

  testWidgets('deleting states the photo count, that photos stay, the child tags and the views', (tester) async {
    when(() => tagging.viewsUsingTag('gym')).thenAnswer((_) async => const [_vetted]);
    when(() => tagging.countTagUsage('gym')).thenAnswer((_) async => (assets: 1234, children: 1));
    when(() => tagging.deleteTag('gym')).thenAnswer((_) async {});
    final t = await pump(tester, privateMode: true);
    await openTag(tester, 'gym');

    await tester.tap(find.byKey(const Key('tag-delete')));
    await tester.pumpAndSettle();

    expect(find.text(t.tag_delete_confirm_title(tag: 'Gym')), findsOneWidget);
    expect(find.text(t.tag_delete_confirm_photos(count: 1234)), findsOneWidget);
    expect(find.text(t.tag_delete_confirm_children(count: 1)), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const Key('delete-tag-views-warning'))).data, contains('Vetted'));
    // the sheet and the dialog both say it
    expect(find.text(t.tag_delete_confirm_keeps_photos), findsNWidgets(2));
    verifyNever(() => tagging.deleteTag(any()));

    await tester.tap(find.byKey(const Key('delete-tag-confirm')));
    await tester.pumpAndSettle();
    verify(() => tagging.deleteTag('gym')).called(1);
    expect(find.text(t.tag_deleted(tag: 'Gym')), findsOneWidget);
  });

  testWidgets('renaming sends the new name and rejects a slash', (tester) async {
    when(
      () => tagging.renameTag(any(), any()),
    ).thenAnswer((_) async => const TagEntry(id: 'gym', ownerId: _me, value: 'Fitness'));
    final t = await pump(tester, privateMode: true);
    await openTag(tester, 'gym');

    await tester.tap(find.byKey(const Key('tag-rename')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('tag-rename-field')), 'A/B');
    await tester.tap(find.byKey(const Key('tag-rename-save')));
    await tester.pumpAndSettle();
    expect(find.text(t.tag_name_invalid), findsOneWidget);

    await tester.enterText(find.byKey(const Key('tag-rename-field')), 'Fitness');
    await tester.tap(find.byKey(const Key('tag-rename-save')));
    await tester.pumpAndSettle();
    verify(() => tagging.renameTag(_gym, 'Fitness')).called(1);
    expect(find.text(t.tag_renamed(tag: 'Fitness')), findsOneWidget);
  });
}
