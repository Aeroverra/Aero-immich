import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/domain/services/remote_album.service.dart';
import 'package:mocktail/mocktail.dart';

import '../../infrastructure/repository.mock.dart';
import '../../service.mocks.dart';
import '../../unit/factories/remote_album_factory.dart';
import '../../unit/factories/user_factory.dart';

void main() {
  late MockRemoteAlbumRepository repository;
  late MockAlbumApiRepository albumApi;
  late RemoteAlbumService sut;

  setUpAll(() {
    registerFallbackValue(PrivateModeFilter.off);
    registerFallbackValue(UserFactory.createDto());
    registerFallbackValue(RemoteAlbumFactory.create());
  });

  setUp(() {
    repository = MockRemoteAlbumRepository();
    albumApi = MockAlbumApiRepository();
    sut = RemoteAlbumService(repository, albumApi, MockForegroundUploadService());

    when(
      () => albumApi.addAssets(
        any(),
        any(),
        abortTrigger: any(named: 'abortTrigger'),
        confirmPrivate: any(named: 'confirmPrivate'),
      ),
    ).thenAnswer((invocation) async => (added: invocation.positionalArguments[1] as List<String>, failed: <String>[]));
    when(() => repository.addAssets(any(), any())).thenAnswer((_) async => 1);
  });

  group('confirmPrivate is forwarded to the API', () {
    test('addAssets defaults to no confirmation and passes it through when given', () async {
      await sut.addAssets(albumId: 'album-1', assetIds: ['a1']);
      verify(
        () => albumApi.addAssets('album-1', ['a1'], abortTrigger: any(named: 'abortTrigger'), confirmPrivate: false),
      ).called(1);

      await sut.addAssets(albumId: 'album-1', assetIds: ['a1'], confirmPrivate: true);
      verify(
        () => albumApi.addAssets('album-1', ['a1'], abortTrigger: any(named: 'abortTrigger'), confirmPrivate: true),
      ).called(1);
    });

    test('addAssetsToAlbum passes the confirmation on for the already uploaded assets', () async {
      final result = await sut.addAssetsToAlbum(
        albumId: 'album-1',
        uploader: UserFactory.createDto(),
        candidates: const AlbumAssetCandidates(remoteAssetIds: ['a1', 'a2'], localAssetsToUpload: []),
        confirmPrivate: true,
      );

      expect(result, 2);
      verify(
        () =>
            albumApi.addAssets('album-1', ['a1', 'a2'], abortTrigger: any(named: 'abortTrigger'), confirmPrivate: true),
      ).called(1);
    });

    test('createAlbum passes the confirmation on', () async {
      final owner = UserFactory.createDto();
      final album = RemoteAlbumFactory.create(ownerId: owner.id);
      when(
        () => albumApi.createDriftAlbum(
          any(),
          any(),
          assetIds: any(named: 'assetIds'),
          description: any(named: 'description'),
          confirmPrivate: any(named: 'confirmPrivate'),
        ),
      ).thenAnswer((_) async => album);
      when(() => repository.create(any(), any())).thenAnswer((_) async {});

      await sut.createAlbum(title: 'Album', owner: owner, assetIds: ['a1'], confirmPrivate: true);

      verify(
        () => albumApi.createDriftAlbum(
          'Album',
          owner,
          assetIds: ['a1'],
          description: any(named: 'description'),
          confirmPrivate: true,
        ),
      ).called(1);
    });
  });

  group('album level private filter is forwarded to the repository', () {
    test('watchAlbum, getCount and getAlbumsContainingAsset pass the filter through', () async {
      const filter = PrivateModeFilter(enabled: true, userId: 'user-1');
      when(
        () => repository.watchAlbum(any(), privateFilter: any(named: 'privateFilter')),
      ).thenAnswer((_) => const Stream.empty());
      when(() => repository.getCount(privateFilter: any(named: 'privateFilter'))).thenAnswer((_) async => 3);
      when(
        () => repository.getAlbumsContainingAsset(any(), privateFilter: any(named: 'privateFilter')),
      ).thenAnswer((_) async => const []);
      when(
        () => repository.getAlbumsContainingAssets(any(), privateFilter: any(named: 'privateFilter')),
      ).thenAnswer((_) async => const []);

      sut.watchAlbum('album-1', privateFilter: filter);
      await sut.getCount(privateFilter: filter);
      await sut.getAlbumsContainingAsset('a1', privateFilter: filter);
      await sut.getAlbumsContainingAssets(['a1', 'a2'], privateFilter: filter);

      verify(() => repository.watchAlbum('album-1', privateFilter: filter)).called(1);
      verify(() => repository.getCount(privateFilter: filter)).called(1);
      verify(() => repository.getAlbumsContainingAsset('a1', privateFilter: filter)).called(1);
      verify(() => repository.getAlbumsContainingAssets(['a1', 'a2'], privateFilter: filter)).called(1);
    });
  });
}
