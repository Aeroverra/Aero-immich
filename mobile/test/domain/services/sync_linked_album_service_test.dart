import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/domain/services/sync_linked_album.service.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/store.provider.dart';
import 'package:immich_mobile/repositories/album_api_repository.dart';
import 'package:mocktail/mocktail.dart';

import '../../infrastructure/repository.mock.dart';
import '../../service.mocks.dart';
import '../../unit/factories/local_album_factory.dart';
import '../../unit/factories/remote_album_factory.dart';

void main() {
  // A container with the service's deps overridden but cancellationProvider left
  // alone, i.e. the root (main) isolate, where cancellationProvider has no
  // override and throws if read. The UI reads this provider here.
  ProviderContainer rootContainer() {
    final drift = MockDrift();
    when(() => drift.localAlbumRepository).thenReturn(MockLocalAlbumRepository());
    when(() => drift.remoteAlbumRepository).thenReturn(MockRemoteAlbumRepository());
    final container = ProviderContainer(
      overrides: [
        driftProvider.overrideWithValue(drift),
        albumApiRepositoryProvider.overrideWithValue(MockAlbumApiRepository()),
        storeServiceProvider.overrideWithValue(MockStoreService()),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  // Regression for #29125 (Sync Albums toggle) and #29119 (can't leave the album
  // selection screen): #28694 made the provider watch cancellationProvider, so
  // reading it off the isolate threw. The cancellation now lives on the isolate
  // call path, not the provider, so the UI can build it.
  test('builds on the root isolate without a cancellationProvider override', () {
    final container = rootContainer();

    expect(() => container.read(syncLinkedAlbumServiceProvider), returnsNormally);
    expect(container.read(syncLinkedAlbumServiceProvider), isA<SyncLinkedAlbumService>());
  });

  test('manageLinkedAlbums runs from the UI without a cancellation signal', () {
    final service = rootContainer().read(syncLinkedAlbumServiceProvider);

    expect(service.manageLinkedAlbums(const [], 'user-1'), completes);
  });

  group('syncLinkedAlbums and private assets', () {
    late MockLocalAlbumRepository localAlbums;
    late MockRemoteAlbumRepository remoteAlbums;
    late MockAlbumApiRepository albumApi;
    late SyncLinkedAlbumService service;
    final localAlbum = LocalAlbumFactory.create(linkedRemoteAlbumId: 'remote-1', backupSelection: .selected);

    setUp(() {
      registerFallbackValue(PrivateModeFilter.off);
      localAlbums = MockLocalAlbumRepository();
      remoteAlbums = MockRemoteAlbumRepository();
      albumApi = MockAlbumApiRepository();
      service = SyncLinkedAlbumService(localAlbums, remoteAlbums, albumApi, MockStoreService());

      when(() => localAlbums.getBackupAlbums()).thenAnswer((_) async => [localAlbum]);
      when(
        () => remoteAlbums.getLinkedAssetIds('user-1', localAlbum.id, 'remote-1'),
      ).thenAnswer((_) async => ['public-1', 'private-1']);
      when(() => remoteAlbums.getPrivateAssetIds(any())).thenAnswer((_) async => ['private-1']);
      when(() => remoteAlbums.addAssets(any(), any())).thenAnswer((_) async => 0);
      when(() => albumApi.addAssets(any(), any(), abortTrigger: any(named: 'abortTrigger'))).thenAnswer(
        (invocation) async => (added: (invocation.positionalArguments[1] as List<String>), failed: <String>[]),
      );
    });

    test('skips the private assets headed for a shared album instead of asking', () async {
      when(
        () => remoteAlbums.get('remote-1', privateFilter: any(named: 'privateFilter')),
      ).thenAnswer((_) async => RemoteAlbumFactory.create(id: 'remote-1', isShared: true));

      await service.syncLinkedAlbums('user-1');

      verify(() => albumApi.addAssets('remote-1', ['public-1'], abortTrigger: any(named: 'abortTrigger'))).called(1);
      verify(() => remoteAlbums.addAssets('remote-1', ['public-1'])).called(1);
    });

    test('uploads private assets into an album nobody else can see', () async {
      when(
        () => remoteAlbums.get('remote-1', privateFilter: any(named: 'privateFilter')),
      ).thenAnswer((_) async => RemoteAlbumFactory.create(id: 'remote-1'));

      await service.syncLinkedAlbums('user-1');

      verify(
        () => albumApi.addAssets('remote-1', ['public-1', 'private-1'], abortTrigger: any(named: 'abortTrigger')),
      ).called(1);
      verifyNever(() => remoteAlbums.getPrivateAssetIds(any()));
    });

    test('looks the linked album up regardless of the session private mode state', () async {
      when(
        () => remoteAlbums.get('remote-1', privateFilter: any(named: 'privateFilter')),
      ).thenAnswer((_) async => RemoteAlbumFactory.create(id: 'remote-1'));

      await service.syncLinkedAlbums('user-1');

      verify(() => remoteAlbums.get('remote-1', privateFilter: PrivateModeFilter.all)).called(1);
    });
  });
}
