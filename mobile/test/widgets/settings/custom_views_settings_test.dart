import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
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
  late _MockTaggingService tagging;

  setUpAll(TestUtils.init);

  setUp(() {
    api = _MockCustomViewApiRepository();
    tagging = _MockTaggingService();
    when(() => api.getAll()).thenAnswer((_) async => const [_gymView, _vetted]);
  });

  Future<void> pump(WidgetTester tester, {required bool privateMode}) async {
    await tester.pumpConsumerWidget(
      const CustomViewsSettings(),
      overrides: [
        customViewsSupportedProvider.overrideWithValue(true),
        privateModeProvider.overrideWith((ref) => _TestPrivateModeNotifier(ref, privateMode)),
        customViewApiRepositoryProvider.overrideWithValue(api),
        taggingServiceProvider.overrideWithValue(tagging),
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

  testWidgets('deleting a tag names the views that use it before it is deleted', (tester) async {
    when(() => tagging.viewsUsingTag('gym')).thenAnswer((_) async => const [_vetted, _gymView]);
    when(() => tagging.deleteTag('gym')).thenAnswer((_) async {});
    await pump(tester, privateMode: true);
    final t = Translations.of(tester.element(find.byType(CustomViewsSettings)));

    await tester.ensureVisible(find.byKey(const Key('tag-setting-gym')));
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(of: find.byKey(const Key('tag-setting-gym')), matching: find.byIcon(Icons.delete_outline)),
    );
    await tester.pumpAndSettle();

    final warning = tester.widget<Text>(find.byKey(const Key('delete-tag-views-warning')));
    expect(warning.data, contains('Vetted'));
    expect(warning.data, contains('Gym only'));
    verifyNever(() => tagging.deleteTag(any()));

    await tester.tap(find.text(t.delete).last);
    await tester.pumpAndSettle();
    verify(() => tagging.deleteTag('gym')).called(1);
  });
}
