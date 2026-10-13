import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/presentation/widgets/tags/tag_assets_sheet.widget.dart';
import 'package:immich_mobile/providers/tagging.provider.dart';
import 'package:mocktail/mocktail.dart';

import '../../../test_utils.dart';
import '../../../widget_tester_extensions.dart';

class _MockTaggingService extends Mock implements TaggingService {}

const _me = 'user-1';
const _gym = TagEntry(id: 'gym', ownerId: _me, value: 'Gym');
const _progress = TagEntry(id: 'progress', ownerId: _me, value: 'Gym/Progress', parentId: 'gym');
const _travel = TagEntry(id: 'travel', ownerId: _me, value: 'Travel');

void main() {
  late _MockTaggingService service;
  late Map<String, int> counts;

  setUpAll(TestUtils.init);

  setUp(() {
    service = _MockTaggingService();
    counts = {'gym': 2, 'travel': 1};
    when(() => service.countTagged(any())).thenAnswer((_) async => counts);
    when(() => service.recentTagIds).thenReturn(const ['travel']);
    when(() => service.addTag(any(), any())).thenAnswer((invocation) async {
      counts = {...counts, invocation.positionalArguments.first as String: 2};
    });
    when(() => service.removeTag(any(), any())).thenAnswer((invocation) async {
      counts = {...counts}..remove(invocation.positionalArguments.first as String);
    });
  });

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpConsumerWidget(
      const TagAssetsSheet(assetIds: ['a', 'b']),
      overrides: [
        taggingServiceProvider.overrideWithValue(service),
        tagTreeProvider.overrideWithValue(buildTagTree(const [_gym, _progress, _travel])),
      ],
    );
    await tester.pumpAndSettle();
  }

  bool? checkbox(WidgetTester tester, String tagId) => tester
      .widget<Checkbox>(find.descendant(of: find.byKey(Key('tag-$tagId')).last, matching: find.byType(Checkbox)))
      .value;

  testWidgets('shows whether all, some or none of the assets carry each tag, with recent tags first', (tester) async {
    await pump(tester);

    expect(checkbox(tester, 'gym'), isTrue);
    expect(checkbox(tester, 'progress'), isFalse);
    expect(checkbox(tester, 'travel'), isNull);
    expect(find.text('1 / 2'), findsWidgets);
    // Travel is listed under Recent and in the tree
    expect(find.byKey(const Key('tag-travel')), findsNWidgets(2));
  });

  testWidgets('a tag some assets carry is added to all of them, a tag all carry is removed', (tester) async {
    await pump(tester);

    await tester.tap(find.byKey(const Key('tag-travel')).last);
    await tester.pumpAndSettle();
    verify(() => service.addTag('travel', ['a', 'b'])).called(1);
    expect(checkbox(tester, 'travel'), isTrue);

    await tester.tap(find.byKey(const Key('tag-gym')).last);
    await tester.pumpAndSettle();
    verify(() => service.removeTag('gym', ['a', 'b'])).called(1);
    expect(checkbox(tester, 'gym'), isFalse);
  });

  testWidgets('searching for a tag that does not exist offers to create it and adds it', (tester) async {
    const created = TagEntry(id: 'new', ownerId: _me, value: 'Unreviewed');
    when(() => service.createTag('Unreviewed')).thenAnswer((_) async => created);
    await pump(tester);

    await tester.enterText(find.byType(TextField), 'Unreviewed');
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('tag-gym')), findsNothing);

    await tester.tap(find.byKey(const Key('tag-create')));
    await tester.pumpAndSettle();
    verify(() => service.createTag('Unreviewed')).called(1);
    verify(() => service.addTag('new', ['a', 'b'])).called(1);
  });
}
