import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/tagging.provider.dart';
import 'package:immich_mobile/repositories/custom_view_api.repository.dart';
import 'package:immich_mobile/widgets/settings/custom_views_settings.dart';
import 'package:mocktail/mocktail.dart';

import '../../test_utils.dart';
import '../../widget_tester_extensions.dart';

class _MockCustomViewApiRepository extends Mock implements CustomViewApiRepository {}

class _TestPrivateModeNotifier extends PrivateModeNotifier {
  _TestPrivateModeNotifier(super.ref, bool enabled) {
    state = enabled;
  }

  @override
  Future<void> refresh() async {}
}

const _me = 'user-1';
const _gym = TagEntry(id: 'gym', ownerId: _me, value: 'Gym');
const _vetted = CustomView(id: 'vetted', ownerId: '', name: 'Vetted', isDefault: true, excludeTagIds: ['gym']);
const _gymView = CustomView(
  id: 'gym-view',
  ownerId: '',
  name: 'Gym only',
  order: 1,
  access: ViewAccess.locked,
  includeAll: false,
  includeTagIds: ['gym'],
);

void main() {
  late _MockCustomViewApiRepository api;

  setUpAll(TestUtils.init);

  setUp(() {
    api = _MockCustomViewApiRepository();
    when(() => api.getAll()).thenAnswer((_) async => const [_gymView, _vetted]);
  });

  Future<void> pump(WidgetTester tester, {required bool privateMode}) async {
    await tester.pumpConsumerWidget(
      const CustomViewsSettings(),
      overrides: [
        customViewsSupportedProvider.overrideWithValue(true),
        privateModeProvider.overrideWith((ref) => _TestPrivateModeNotifier(ref, privateMode)),
        customViewApiRepositoryProvider.overrideWithValue(api),
        tagTreeProvider.overrideWithValue(buildTagTree(const [_gym])),
      ],
    );
    await tester.pumpAndSettle();
  }

  testWidgets('views are managed only while private mode is unlocked', (tester) async {
    await pump(tester, privateMode: false);

    expect(find.byKey(const Key('custom-views-unlock')), findsOneWidget);
    expect(find.text('Vetted'), findsNothing);
    verifyNever(() => api.getAll());
  });

  testWidgets('lists the views in their order with the default and a summary', (tester) async {
    await pump(tester, privateMode: true);
    final t = Translations.of(tester.element(find.byType(CustomViewsSettings)));

    final vetted = tester.getTopLeft(find.text('Vetted'));
    final gymOnly = tester.getTopLeft(find.text('Gym only'));
    expect(vetted.dy, lessThan(gymOnly.dy));
    expect(find.text(t.custom_view_default), findsOneWidget);
    expect(
      find.text('${t.custom_view_summary_everything}, ${t.custom_view_summary_excluded(count: 1)}'),
      findsOneWidget,
    );
    expect(find.text(t.custom_view_summary_tags(count: 1)), findsOneWidget);
    expect(find.byIcon(Icons.lock_outline_rounded), findsOneWidget);
  });

  testWidgets('the views screen lists no tags and links to the tags screen', (tester) async {
    await pump(tester, privateMode: true);
    final t = Translations.of(tester.element(find.byType(CustomViewsSettings)));

    expect(find.byKey(const Key('tag-setting-gym')), findsNothing);
    expect(find.byType(Switch), findsNothing);
    expect(find.byIcon(Icons.delete_outline), findsNothing);
    expect(find.text(t.tag_review), findsNothing);
    await tester.scrollUntilVisible(
      find.byKey(const Key('custom-views-manage-tags')),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text(t.custom_views_manage_tags_description), findsOneWidget);
  });

  testWidgets('offers the three lock triggers, on the screen turning off by default', (tester) async {
    await pump(tester, privateMode: true);
    final t = Translations.of(tester.element(find.byType(CustomViewsSettings)));

    await tester.scrollUntilVisible(find.text(t.lock_trigger_timeout), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text(t.custom_view_lock_trigger), findsOneWidget);
    expect(find.text(t.lock_trigger_app_pause), findsOneWidget);
    expect(find.text(t.lock_trigger_screen_off), findsOneWidget);
    expect(find.text(t.lock_trigger_timeout), findsOneWidget);

    final selected = tester.widgetList<RadioListTile<LockTrigger>>(find.byType(RadioListTile<LockTrigger>));
    expect(selected.map((tile) => tile.value), [LockTrigger.appPause, LockTrigger.screenOff, LockTrigger.timeout]);
  });

  testWidgets('the lock trigger is offered while private mode is locked', (tester) async {
    await pump(tester, privateMode: false);
    final t = Translations.of(tester.element(find.byType(CustomViewsSettings)));

    await tester.scrollUntilVisible(find.text(t.lock_trigger_timeout), 200);
    expect(find.text(t.custom_view_lock_trigger), findsOneWidget);
  });
}
