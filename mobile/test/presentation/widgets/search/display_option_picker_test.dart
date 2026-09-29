import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';
import 'package:immich_mobile/widgets/search/search_filter/display_option_picker.dart';

import '../../../widget_tester_extensions.dart';

void main() {
  testWidgets('shows the no-tags option only when tags are enabled', (tester) async {
    await tester.pumpConsumerWidget(DisplayOptionPicker(onSelect: (_) {}));

    expect(find.text('Not in album'), findsOneWidget);
    expect(find.text('No tags'), findsNothing);

    await tester.pumpConsumerWidget(DisplayOptionPicker(onSelect: (_) {}, tagsEnabled: true));

    expect(find.text('No tags'), findsOneWidget);
  });

  testWidgets('reads the initial no-tags state from the filter', (tester) async {
    const filter = SearchDisplayFilters(isNotInAlbum: false, isArchive: false, isFavorite: false, hasNoTags: true);

    await tester.pumpConsumerWidget(DisplayOptionPicker(onSelect: (_) {}, filter: filter, tagsEnabled: true));

    final tile = tester.widget<CheckboxListTile>(
      find.ancestor(of: find.text('No tags'), matching: find.byType(CheckboxListTile)),
    );
    expect(tile.value, isTrue);
  });

  testWidgets('toggling no tags reports the whole selection', (tester) async {
    Map<DisplayOption, bool>? selected;
    const filter = SearchDisplayFilters(isNotInAlbum: true, isArchive: false, isFavorite: false, hasNoTags: false);

    await tester.pumpConsumerWidget(
      DisplayOptionPicker(onSelect: (value) => selected = value, filter: filter, tagsEnabled: true),
    );

    await tester.tap(find.text('No tags'));
    await tester.pump();

    expect(selected, {
      DisplayOption.notInAlbum: true,
      DisplayOption.favorite: false,
      DisplayOption.archive: false,
      DisplayOption.noTags: true,
    });

    await tester.tap(find.text('No tags'));
    await tester.pump();

    expect(selected?[DisplayOption.noTags], isFalse);
    expect(selected?[DisplayOption.notInAlbum], isTrue);
  });
}
