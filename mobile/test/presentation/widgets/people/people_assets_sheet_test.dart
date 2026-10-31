import 'dart:io';

import 'package:drift/drift.dart' show DatabaseConnection;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/people.service.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/presentation/widgets/people/people_assets_sheet.widget.dart';
import 'package:immich_mobile/providers/infrastructure/people.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/services/toast.service.dart';
import 'package:mocktail/mocktail.dart';

import '../../../mock_http_override.dart';
import '../../../test_utils.dart';
import '../../../widget_tester_extensions.dart';

class _MockPeopleService extends Mock implements PeopleService {}

class _MockToastService extends Mock implements ToastService {}

const _ann = Person(id: 'ann', name: 'Ann');
const _bob = Person(id: 'bob', name: 'Bob');
const _cleo = Person(id: 'cleo', name: 'Cleo');

void main() {
  late _MockPeopleService service;
  late _MockToastService toast;
  late Map<String, ({int count, int removable})> counts;
  late int changes;

  late Drift db;

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

  setUp(() {
    service = _MockPeopleService();
    toast = _MockToastService();
    changes = 0;
    // Ann is on both assets (on one through a found face), Bob on one of them, Cleo on none
    counts = {'ann': (count: 2, removable: 1), 'bob': (count: 1, removable: 1)};
    when(() => service.countOnAssets(any())).thenAnswer((_) async => counts);
    when(() => service.addToAssets(any(), any())).thenAnswer((invocation) async {
      counts = {...counts, invocation.positionalArguments.first as String: (count: 2, removable: 2)};
      return const ['a', 'b'];
    });
    when(() => service.removeFromAssets(any(), any())).thenAnswer((invocation) async {
      counts = {...counts, invocation.positionalArguments.first as String: (count: 1, removable: 0)};
      return (removed: const ['a'], kept: const ['b']);
    });
  });

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpConsumerWidget(
      PeopleAssetsSheet(assetIds: const ['a', 'b'], onChanged: () => changes++),
      overrides: [
        peopleServiceProvider.overrideWithValue(service),
        toastServiceProvider.overrideWithValue(toast),
        getAllPeopleProvider.overrideWith((ref) => Stream.value(const [_cleo, _bob, _ann])),
      ],
    );
    await tester.pumpAndSettle();
  }

  bool? checkbox(WidgetTester tester, String personId) => tester
      .widget<Checkbox>(find.descendant(of: find.byKey(Key('person-$personId')), matching: find.byType(Checkbox)))
      .value;

  List<String> order(WidgetTester tester) =>
      tester.widgetList<ListTile>(find.byType(ListTile)).map((tile) => (tile.key! as ValueKey<String>).value).toList();

  testWidgets('shows who is on all, some or none of the assets, people on them first', (tester) async {
    await pump(tester);

    expect(order(tester), ['person-bob', 'person-ann', 'person-cleo']);
    expect(checkbox(tester, 'ann'), isTrue);
    expect(checkbox(tester, 'bob'), isNull);
    expect(checkbox(tester, 'cleo'), isFalse);
    expect(find.text('1 / 2'), findsOneWidget);
  });

  testWidgets('adds a person some or none of the assets have to all of them', (tester) async {
    await pump(tester);

    await tester.tap(find.byKey(const Key('person-bob')));
    await tester.pumpAndSettle();

    verify(() => service.addToAssets('bob', ['a', 'b'])).called(1);
    expect(checkbox(tester, 'bob'), isTrue);
    expect(changes, 1);
  });

  testWidgets('takes a person all assets have off them and says where a face keeps them', (tester) async {
    await pump(tester);

    await tester.tap(find.byKey(const Key('person-ann')));
    await tester.pumpAndSettle();

    verify(() => service.removeFromAssets('ann', ['a', 'b'])).called(1);
    verify(() => toast.info(StaticTranslations.instance.people_kept_on_faces(count: 1))).called(1);
    expect(checkbox(tester, 'ann'), isNull);
    expect(changes, 1);
  });

  testWidgets('filters people by name', (tester) async {
    await pump(tester);

    await tester.enterText(find.byType(TextField), 'cl');
    await tester.pumpAndSettle();

    expect(order(tester), ['person-cleo']);
  });
}
