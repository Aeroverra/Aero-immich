import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/domain/services/user.service.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/remote_album.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/widgets/search/search_filter/album_filter_picker.dart';
import 'package:mocktail/mocktail.dart';

import '../../test_utils.dart';
import '../../widget_tester_extensions.dart';

class _MockUserService extends Mock implements UserService {}

const _me = 'user-1';

RemoteAlbum _album(String id, String name, {String ownerId = _me, String ownerName = 'Me'}) => RemoteAlbum(
  id: id,
  name: name,
  ownerId: ownerId,
  description: '',
  createdAt: DateTime(2026),
  updatedAt: DateTime(2026),
  isActivityEnabled: false,
  order: AlbumAssetOrder.desc,
  assetCount: 1,
  ownerName: ownerName,
  isShared: ownerId != _me,
);

/// The user's albums without a database behind them
class _FakeRemoteAlbumNotifier extends RemoteAlbumNotifier {
  @override
  RemoteAlbumState build() => RemoteAlbumState(
    albums: [
      _album('work', 'Work'),
      _album('trip', 'Trip'),
      _album('family', 'Family', ownerId: 'user-2', ownerName: 'Mom'),
    ],
  );

  @override
  Future<void> refresh() async {}
}

void main() {
  setUpAll(TestUtils.init);

  Future<List<(Set<String>, Set<String>)>> pump(WidgetTester tester, {Set<String> initialIncluded = const {}}) async {
    final changes = <(Set<String>, Set<String>)>[];
    final userService = _MockUserService();
    when(
      () => userService.tryGetMyUser(),
    ).thenReturn(UserDto(id: _me, email: 'user@test.dev', name: 'Me', profileChangedAt: DateTime(2026)));
    when(() => userService.watchMyUser()).thenAnswer((_) => const Stream.empty());

    await tester.pumpConsumerWidget(
      Scaffold(
        body: AlbumFilterPicker(
          initialIncluded: initialIncluded,
          initialExcluded: const {},
          onChanged: (included, excluded) => changes.add((included, excluded)),
        ),
      ),
      overrides: [
        remoteAlbumProvider.overrideWith(_FakeRemoteAlbumNotifier.new),
        currentUserProvider.overrideWith((ref) => CurrentUserProvider(userService)),
      ],
    );
    return changes;
  }

  testWidgets('an album moves between the albums a search looks in and the ones it leaves out', (tester) async {
    final changes = await pump(tester, initialIncluded: {'trip'});

    await tester.tap(find.text('Not in these albums'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Work'));
    await tester.pumpAndSettle();
    expect(changes.last.$1, {'trip'});
    expect(changes.last.$2, {'work'});

    // picking a left out album as one to look in takes it out of the other list
    await tester.tap(find.text('In these albums'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Work'));
    await tester.pumpAndSettle();
    expect(changes.last.$1, {'trip', 'work'});
    expect(changes.last.$2, isEmpty);

    // tapping a picked album again unpicks it
    await tester.tap(find.text('Trip'));
    await tester.pumpAndSettle();
    expect(changes.last.$1, {'work'});
    expect(changes.last.$2, isEmpty);
  });

  testWidgets('lists own and shared albums by name and narrows them by the search', (tester) async {
    await pump(tester);

    final names = tester.widgetList<ListTile>(find.byType(ListTile)).map((tile) => (tile.title! as Text).data).toList();
    expect(names, ['Family', 'Trip', 'Work']);
    expect(find.text('Shared by Mom'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'TR');
    await tester.pumpAndSettle();
    expect(find.text('Trip'), findsOneWidget);
    expect(find.text('Work'), findsNothing);
    expect(find.text('Family'), findsNothing);

    await tester.enterText(find.byType(TextField), 'nothing like it');
    await tester.pumpAndSettle();
    expect(find.text('No albums found'), findsOneWidget);
  });
}
