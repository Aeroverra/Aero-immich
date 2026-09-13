import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/db/main/dao/person.dart';
import 'package:immich_mobile/data/server/person.dart';
import 'package:immich_mobile/domain/models/config/app_config.dart';
import 'package:immich_mobile/domain/models/map.model.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';
import 'package:immich_mobile/domain/services/user.service.dart';
import 'package:immich_mobile/infrastructure/repositories/map.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/timeline.repository.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/map.provider.dart';
import 'package:immich_mobile/providers/infrastructure/memory.provider.dart';
import 'package:immich_mobile/providers/infrastructure/people.provider.dart';
import 'package:immich_mobile/providers/infrastructure/remote_album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:maplibre_gl/maplibre_gl.dart';
import 'package:mocktail/mocktail.dart';

import '../infrastructure/repository.mock.dart';
import '../service.mocks.dart';
import '../unit/factories/remote_album_factory.dart';

class _MockTimelineRepository extends Mock implements TimelineRepository {}

class _MockMapRepository extends Mock implements MapRepository {}

class _MockPeopleRepository extends Mock implements PeopleRepository {}

class _MockPersonApiRepository extends Mock implements PersonApiRepository {}

class _MockUserService extends Mock implements UserService {}

/// Flips the session state without talking to the server
class _TestPrivateModeNotifier extends PrivateModeNotifier {
  _TestPrivateModeNotifier(super.ref);

  void set(bool enabled) => state = enabled;

  @override
  Future<void> refresh() async {}
}

/// Every provider that lists assets or albums must re-query with the new filter the moment the
/// session's private mode flips, so that no page keeps showing (or hiding) private content.
void main() {
  const userId = 'user-1';
  const on = PrivateModeFilter(enabled: true, userId: userId);
  const off = PrivateModeFilter(enabled: false, userId: userId);

  late _MockTimelineRepository timeline;
  late _MockMapRepository map;
  late _MockPeopleRepository people;
  late MockMemoryRepository memory;
  late MockAssetService assetService;
  late MockRemoteAlbumService albumService;
  late MockSettingsRepository settings;
  late _MockUserService userService;
  late ProviderContainer container;

  TimelineQuery emptyQuery(TimelineOrigin origin) =>
      (assetSource: (_, _) async => const [], bucketSource: () => Stream.value(const []), origin: origin);

  setUpAll(() {
    registerFallbackValue(PrivateModeFilter.off);
    registerFallbackValue(GroupAssetsBy.day);
    registerFallbackValue(
      TimelineMapOptions(
        bounds: LatLngBounds(southwest: const LatLng(0, 0), northeast: const LatLng(0, 0)),
      ),
    );
  });

  setUp(() {
    timeline = _MockTimelineRepository();
    map = _MockMapRepository();
    people = _MockPeopleRepository();
    memory = MockMemoryRepository();
    assetService = MockAssetService();
    albumService = MockRemoteAlbumService();
    settings = MockSettingsRepository();
    userService = _MockUserService();

    final user = UserDto(id: userId, email: 'user@test.dev', name: 'user', profileChangedAt: DateTime(2026));
    when(() => userService.tryGetMyUser()).thenReturn(user);
    when(() => userService.watchMyUser()).thenAnswer((_) => const Stream.empty());
    when(() => settings.appConfig).thenReturn(const AppConfig());
    when(() => settings.watchConfig()).thenAnswer((_) => const Stream.empty());

    when(() => timeline.watchTimelineUserIds(userId)).thenAnswer((_) => Stream.value([]));
    when(
      () => timeline.main(any(), any(), privateFilter: any(named: 'privateFilter')),
    ).thenReturn(emptyQuery(TimelineOrigin.main));
    when(
      () => timeline.favorite(any(), any(), privateFilter: any(named: 'privateFilter')),
    ).thenReturn(emptyQuery(TimelineOrigin.favorite));
    when(
      () => timeline.archived(any(), any(), privateFilter: any(named: 'privateFilter')),
    ).thenReturn(emptyQuery(TimelineOrigin.archive));
    when(
      () => timeline.trash(any(), any(), privateFilter: any(named: 'privateFilter')),
    ).thenReturn(emptyQuery(TimelineOrigin.trash));
    when(
      () => timeline.recentlyAdded(any(), any(), privateFilter: any(named: 'privateFilter')),
    ).thenReturn(emptyQuery(TimelineOrigin.recentlyAdded));
    when(
      () => timeline.privateFolder(any(), any(), privateFilter: any(named: 'privateFilter')),
    ).thenReturn(emptyQuery(TimelineOrigin.privateFolder));
    when(
      () => timeline.remoteAlbum(any(), any(), privateFilter: any(named: 'privateFilter')),
    ).thenReturn(emptyQuery(TimelineOrigin.remoteAlbum));
    when(
      () => map.remote(any(), any(), privateFilter: any(named: 'privateFilter')),
    ).thenReturn((markerSource: (_) async => const []));
    when(
      () => people.watch(
        minFaces: any(named: 'minFaces'),
        privateFilter: any(named: 'privateFilter'),
      ),
    ).thenAnswer((_) => Stream.value(const []));
    when(
      () => memory.getAll(
        userId,
        onlyToday: any(named: 'onlyToday'),
        onlyFavorites: any(named: 'onlyFavorites'),
        privateFilter: any(named: 'privateFilter'),
      ),
    ).thenAnswer((_) async => const []);
    when(
      () => assetService.getPlaces(userId, privateFilter: any(named: 'privateFilter')),
    ).thenAnswer((_) async => const []);
    when(() => albumService.getAll(privateFilter: any(named: 'privateFilter'))).thenAnswer((_) async => const []);
    when(
      () => albumService.getAlbumsContainingAsset(any(), privateFilter: any(named: 'privateFilter')),
    ).thenAnswer((_) async => const []);
    when(
      () => albumService.watchDateRange(any(), privateFilter: any(named: 'privateFilter')),
    ).thenAnswer((_) => Stream.value((DateTime(2026), DateTime(2026))));
    // a private album exists for the session only while the mode is on
    when(() => albumService.get('album-1', privateFilter: any(named: 'privateFilter'))).thenAnswer(
      (invocation) async => (invocation.namedArguments[#privateFilter] as PrivateModeFilter).enabled
          ? RemoteAlbumFactory.create(id: 'album-1')
          : null,
    );

    final drift = MockDrift();
    when(() => drift.timelineRepository).thenReturn(timeline);
    when(() => drift.mapRepository).thenReturn(map);
    when(() => drift.peopleRepository).thenReturn(people);
    when(() => drift.memoryRepository).thenReturn(memory);

    container = ProviderContainer(
      overrides: [
        driftProvider.overrideWithValue(drift),
        personApiRepositoryProvider.overrideWithValue(_MockPersonApiRepository()),
        privateModeProvider.overrideWith(_TestPrivateModeNotifier.new),
        currentUserProvider.overrideWith((ref) => CurrentUserProvider(userService)),
        assetServiceProvider.overrideWithValue(assetService),
        remoteAlbumServiceProvider.overrideWithValue(albumService),
        settingsProvider.overrideWithValue(settings),
        userMetadataPreferencesProvider.overrideWith((ref) async => null),
      ],
    );
    addTearDown(container.dispose);
  });

  void flip(bool enabled) => (container.read(privateModeProvider.notifier) as _TestPrivateModeNotifier).set(enabled);

  Future<void> settle() => Future<void>.delayed(Duration.zero);

  test('the filter every query receives follows the toggle', () {
    expect(container.read(privateModeFilterProvider), off);
    flip(true);
    expect(container.read(privateModeFilterProvider), on);
    flip(false);
    expect(container.read(privateModeFilterProvider), off);
  });

  test('the main timeline service is rebuilt with the new filter', () async {
    final services = <TimelineService>[];
    container.listen(timelineServiceProvider, (_, next) => services.add(next), fireImmediately: true);
    await settle();
    verify(() => timeline.main(any(), any(), privateFilter: off)).called(1);

    flip(true);
    await settle();

    verify(() => timeline.main(any(), any(), privateFilter: on)).called(1);
    expect(services, hasLength(2), reason: 'a fresh service replaces the one built with the old filter');
  });

  test('favorites, archive, trash, recently added and the private folder get the new filter', () {
    container.listen(timelineFactoryProvider, (_, _) {});
    flip(true);

    final factory = container.read(timelineFactoryProvider);
    expect(factory.privateFilter, on);
    factory.favorite(userId);
    factory.archive(userId);
    factory.trash(userId);
    factory.recentlyAdded(userId);
    factory.privateFolder(userId);
    factory.remoteAlbum(albumId: 'album-1');

    verify(() => timeline.favorite(userId, any(), privateFilter: on)).called(1);
    verify(() => timeline.archived(userId, any(), privateFilter: on)).called(1);
    verify(() => timeline.trash(userId, any(), privateFilter: on)).called(1);
    verify(() => timeline.recentlyAdded(userId, any(), privateFilter: on)).called(1);
    verify(() => timeline.privateFolder(userId, any(), privateFilter: on)).called(1);
    verify(() => timeline.remoteAlbum('album-1', any(), privateFilter: on)).called(1);
  });

  test('places re-query with the new filter', () async {
    container.listen(placesProvider, (_, _) {});
    await settle();
    verify(() => assetService.getPlaces(userId, privateFilter: off)).called(1);

    flip(true);
    await settle();

    verify(() => assetService.getPlaces(userId, privateFilter: on)).called(1);
  });

  test('people re-watch with the new filter', () async {
    container.listen(getAllPeopleProvider, (_, _) {});
    await settle();
    verify(() => people.watch(minFaces: 3, privateFilter: off)).called(1);

    flip(true);
    await settle();

    verify(() => people.watch(minFaces: 3, privateFilter: on)).called(1);
  });

  test('the map service is rebuilt with the new filter', () async {
    container.listen(mapServiceProvider, (_, _) {});
    verify(() => map.remote([userId], any(), privateFilter: off)).called(1);

    flip(true);
    await settle();

    verify(() => map.remote([userId], any(), privateFilter: on)).called(1);
  });

  test('the memory lane and the memories list re-query with the new filter', () async {
    container.listen(memoryLaneProvider, (_, _) {});
    container.listen(allMemoriesProvider(false), (_, _) {});
    await settle();
    verify(() => memory.getAll(userId, privateFilter: off)).called(1);
    verify(() => memory.getAll(userId, onlyToday: false, onlyFavorites: false, privateFilter: off)).called(1);

    flip(true);
    await settle();

    verify(() => memory.getAll(userId, privateFilter: on)).called(1);
    verify(() => memory.getAll(userId, onlyToday: false, onlyFavorites: false, privateFilter: on)).called(1);
  });

  test('the album list refreshes with the new filter', () async {
    container.listen(remoteAlbumProvider, (_, _) {});
    await settle();

    flip(true);
    await settle();

    verify(() => albumService.getAll(privateFilter: on)).called(1);
  });

  test('the albums an asset appears in are re-queried with the new filter', () async {
    container.listen(albumsContainingAssetProvider('asset-1'), (_, _) {});
    await settle();
    verify(() => albumService.getAlbumsContainingAsset('asset-1', privateFilter: off)).called(1);

    flip(true);
    await settle();

    verify(() => albumService.getAlbumsContainingAsset('asset-1', privateFilter: on)).called(1);
  });

  test('the album detail date range re-subscribes with the new filter', () async {
    container.listen(remoteAlbumDateRangeProvider('album-1'), (_, _) {});
    await settle();
    verify(() => albumService.watchDateRange('album-1', privateFilter: off)).called(1);

    flip(true);
    await settle();

    verify(() => albumService.watchDateRange('album-1', privateFilter: on)).called(1);
  });

  test('an open private album stops being visible when the mode turns off', () async {
    flip(true);
    final visibility = <bool>[];
    container.listen(
      remoteAlbumVisibleProvider('album-1'),
      (_, next) => next.whenData(visibility.add),
      fireImmediately: true,
    );
    await settle();
    expect(visibility, [true]);

    flip(false);
    await settle();

    expect(visibility, [true, false]);
  });
}
