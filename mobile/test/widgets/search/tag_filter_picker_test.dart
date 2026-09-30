import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/tag.model.dart';
import 'package:immich_mobile/providers/infrastructure/tag.provider.dart';
import 'package:immich_mobile/widgets/search/search_filter/tag_filter_picker.dart';

import '../../test_utils.dart';
import '../../widget_tester_extensions.dart';

class _FakeTagNotifier extends TagNotifier {
  @override
  Future<Set<Tag>> build() async => {const Tag(id: 'work', value: 'Work'), const Tag(id: 'holiday', value: 'Holiday')};
}

void main() {
  setUpAll(TestUtils.init);

  testWidgets('a tag moves between the tags a search needs and the ones it leaves out', (tester) async {
    // the upstream TagPicker draws its ListTiles in a coloured DecoratedBox, which debug builds report
    final reportError = FlutterError.onError;
    FlutterError.onError = (details) {
      if (!details.exceptionAsString().contains('ListTile background color or ink splashes may be invisible')) {
        reportError?.call(details);
      }
    };
    addTearDown(() => FlutterError.onError = reportError);
    (Set<String>, Set<String>)? changed;
    await tester.pumpConsumerWidget(
      Scaffold(
        body: TagFilterPicker(
          initialIncluded: const {'work'},
          initialExcluded: const {},
          onChanged: (included, excluded) => changed = (included, excluded),
        ),
      ),
      overrides: [tagProvider.overrideWith(_FakeTagNotifier.new)],
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.label_off_outlined));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Holiday'));
    await tester.pumpAndSettle();
    expect(changed?.$1, {'work'});
    expect(changed?.$2, {'holiday'});

    // picking an excluded tag as a needed one takes it out of the excluded list
    await tester.tap(find.byIcon(Icons.sell_outlined));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Holiday'));
    await tester.pumpAndSettle();
    expect(changed?.$1, {'work', 'holiday'});
    expect(changed?.$2, isEmpty);
  });
}
