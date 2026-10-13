import 'dart:io';

import 'package:drift/drift.dart' show DatabaseConnection;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/providers/infrastructure/people.provider.dart';
import 'package:immich_mobile/widgets/search/search_filter/people_filter_picker.dart';

import '../../mock_http_override.dart';
import '../../test_utils.dart';
import '../../widget_tester_extensions.dart';

const _ann = Person(id: 'ann', name: 'Ann');
const _bob = Person(id: 'bob', name: 'Bob');
const PeopleFilterOptions _none = noPeopleFilterOptions;

void main() {
  late Drift db;

  // the list shows face thumbnails from the server
  setUpAll(() async {
    TestUtils.init();
    HttpOverrides.global = MockHttpOverrides();
    db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: StoreRepository(db));
    await Store.put(StoreKey.serverEndpoint, 'http://localhost/api');
  });

  tearDownAll(() async {
    HttpOverrides.global = null;
    await db.close();
  });

  Future<List<(Set<Person>, PeopleFilterOptions)>> pump(
    WidgetTester tester, {
    Set<Person> initialPeople = const {},
    PeopleFilterOptions initialOptions = _none,
  }) async {
    final changes = <(Set<Person>, PeopleFilterOptions)>[];
    await tester.pumpConsumerWidget(
      Scaffold(
        body: PeopleFilterPicker(
          initialPeople: initialPeople,
          initialOptions: initialOptions,
          onChanged: (people, options) => changes.add((people, options)),
        ),
      ),
      overrides: [
        getAllPeopleProvider.overrideWith((ref) => Stream.value([_ann, _bob])),
      ],
    );
    await tester.pumpAndSettle();
    return changes;
  }

  FilterChip chip(WidgetTester tester, String key) => tester.widget<FilterChip>(find.byKey(Key(key)));
  Future<void> tap(WidgetTester tester, String key) async {
    await tester.tap(find.byKey(Key(key)));
    await tester.pumpAndSettle();
  }

  testWidgets('only these people and with others need a picked person', (tester) async {
    final changes = await pump(tester);

    expect(chip(tester, 'people-filter-only-true').onSelected, isNull);
    expect(chip(tester, 'people-filter-only-false').onSelected, isNull);

    await tester.tap(find.text('Ann'));
    await tester.pumpAndSettle();
    await tap(tester, 'people-filter-only-true');

    expect(changes.last.$1, {_ann});
    expect(changes.last.$2.onlyPeople, isTrue);
    expect(
      find.text('Leaves out photos and videos with anyone else in them, faces without a name included'),
      findsOneWidget,
    );

    // the other side replaces it, the picked side again clears it
    await tap(tester, 'people-filter-only-false');
    expect(changes.last.$2.onlyPeople, isFalse);
    await tap(tester, 'people-filter-only-false');
    expect(changes.last.$2.onlyPeople, isNull);
  });

  testWidgets('no people sets the people and the other options aside', (tester) async {
    final changes = await pump(tester, initialPeople: {_ann});

    await tap(tester, 'people-filter-any-false');

    expect(changes.last.$2.hasPeople, isFalse);
    expect(chip(tester, 'people-filter-only-true').onSelected, isNull);
    expect(chip(tester, 'people-filter-named-true').onSelected, isNull);
    expect(chip(tester, 'people-filter-unnamed-false').onSelected, isNull);

    // the list can not be used while no people is on
    await tester.tap(find.text('Bob'), warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(changes.last.$1, {_ann});

    await tap(tester, 'people-filter-any-true');
    await tap(tester, 'people-filter-unnamed-true');
    expect(changes.last.$1, {_ann});
    expect(changes.last.$2, (onlyPeople: null, hasPeople: true, hasNamedFaces: null, hasUnnamedFaces: true));
  });

  testWidgets('no named people sets the people aside but keeps the face options', (tester) async {
    final changes = await pump(tester, initialPeople: {_ann});

    await tap(tester, 'people-filter-named-false');

    expect(changes.last.$2.hasNamedFaces, isFalse);
    expect(chip(tester, 'people-filter-only-true').onSelected, isNull);
    expect(chip(tester, 'people-filter-unnamed-true').onSelected, isNotNull);
  });

  testWidgets('labels the People chip', (tester) async {
    await pump(tester);
    final context = tester.element(find.byType(PeopleFilterPicker));
    PeopleFilterOptions options({bool? only, bool? any, bool? named, bool? unnamed}) =>
        (onlyPeople: only, hasPeople: any, hasNamedFaces: named, hasUnnamedFaces: unnamed);

    expect(peopleFilterLabel(context, {}, _none), '');
    expect(peopleFilterLabel(context, {_ann, _bob}, _none), 'Ann, Bob');
    expect(peopleFilterLabel(context, {_ann}, options(only: true, unnamed: true)), 'Ann only · With unnamed faces');
    expect(peopleFilterLabel(context, {_ann}, options(only: false)), 'Ann with others');
    expect(
      peopleFilterLabel(context, {_ann}, options(named: false, unnamed: false)),
      'No named people · No unnamed faces',
    );
    expect(peopleFilterLabel(context, {}, options(named: true)), 'With named people');
    expect(peopleFilterLabel(context, {}, options(any: true)), 'With people');
    expect(peopleFilterLabel(context, {_ann}, options(only: true, any: false, unnamed: true)), 'No people');
  });
}
