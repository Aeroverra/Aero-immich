import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/presentation/pages/hidden_asset.page.dart';

import '../../test_utils.dart';
import '../../widget_tester_extensions.dart';

const _me = 'user-1';
const _all = CustomView(id: 'all-view', ownerId: _me, name: 'All', access: ViewAccess.private);
const _gym = CustomView(id: 'gym', ownerId: _me, name: 'Gym', access: ViewAccess.locked);

void main() {
  setUpAll(TestUtils.init);

  /// Puts a button on screen that opens the sheet; [_Result] holds what the sheet closed with
  Future<_Result> pump(
    WidgetTester tester, {
    List<CustomView> views = const [_all, _gym],
    bool allPhotos = false,
  }) async {
    final result = _Result();
    await tester.pumpConsumerWidget(
      Builder(
        builder: (context) => TextButton(
          onPressed: () async {
            result.choice = await showModalBottomSheet<HiddenAssetViewChoice>(
              context: context,
              builder: (_) => HiddenAssetViewSheet(views: views, allPhotos: allPhotos, currentViewName: 'Default'),
            );
            result.closed = true;
          },
          child: const Text('open'),
        ),
      ),
    );
    return result;
  }

  Future<void> open(WidgetTester tester) async {
    await tester.pumpAndSettle();
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  testWidgets('names the current view and lists the views that show the asset', (tester) async {
    await pump(tester);
    await open(tester);

    expect(find.textContaining('Default'), findsOneWidget);
    expect(find.text('All'), findsOneWidget);
    expect(find.text('Gym'), findsOneWidget);
    expect(find.byKey(const Key('hidden-asset-view-all-view')), findsOneWidget);
    expect(find.byKey(const Key('hidden-asset-view-gym')), findsOneWidget);
    expect(find.byKey(const Key('hidden-asset-all-photos')), findsNothing);
    expect(
      find.descendant(
        of: find.byKey(const Key('hidden-asset-view-gym')),
        matching: find.byIcon(Icons.lock_outline_rounded),
      ),
      findsOneWidget,
    );
  });

  testWidgets('closes with the chosen view', (tester) async {
    final result = await pump(tester);
    await open(tester);

    await tester.tap(find.text('Gym'));
    await tester.pumpAndSettle();

    expect(result.closed, isTrue);
    expect(result.choice?.view, _gym);
  });

  testWidgets('offers all photos as a choice without a view', (tester) async {
    final result = await pump(tester, views: const [], allPhotos: true);
    await open(tester);

    await tester.tap(find.byKey(const Key('hidden-asset-all-photos')));
    await tester.pumpAndSettle();

    expect(result.choice, isNotNull);
    expect(result.choice!.view, isNull);
  });

  testWidgets('closes without a choice when cancelled', (tester) async {
    final result = await pump(tester);
    await open(tester);

    await tester.tap(find.byKey(const Key('hidden-asset-cancel')));
    await tester.pumpAndSettle();

    expect(result.closed, isTrue);
    expect(result.choice, isNull);
  });
}

class _Result {
  HiddenAssetViewChoice? choice;
  bool closed = false;
}
