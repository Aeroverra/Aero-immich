import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/repositories/album_api_repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

class _MockAlbumsApi extends Mock implements AlbumsApi {}

void main() {
  late _MockAlbumsApi api;
  late AlbumApiRepository repo;

  setUpAll(() {
    registerFallbackValue(AlbumAddAssetsDto(ids: const []));
    registerFallbackValue(CreateAlbumDto(albumName: ''));
    registerFallbackValue(AddUsersDto());
  });

  setUp(() {
    api = _MockAlbumsApi();
    repo = AlbumApiRepository(api);
  });

  void stubResponse(List<BulkIdResponseDto> response) {
    when(
      () => api.addAssetsToAlbum(any(), any(), abortTrigger: any(named: 'abortTrigger')),
    ).thenAnswer((_) async => response);
  }

  test('no_permission failure surfaces as failed, not added (the #22342 bug)', () async {
    stubResponse([
      BulkIdResponseDto(id: 'a1', success: false, error: const Optional.present(BulkIdErrorReason.noPermission)),
    ]);

    final result = await repo.addAssets('album1', ['a1']);

    expect(result.added, isEmpty);
    expect(result.failed, ['a1']);
  });

  test('duplicate is neither added nor failed (genuinely already in album)', () async {
    stubResponse([
      BulkIdResponseDto(id: 'a1', success: false, error: const Optional.present(BulkIdErrorReason.duplicate)),
    ]);

    final result = await repo.addAssets('album1', ['a1']);

    expect(result.added, isEmpty);
    expect(result.failed, isEmpty);
  });

  test('success is added', () async {
    stubResponse([BulkIdResponseDto(id: 'a1', success: true)]);

    final result = await repo.addAssets('album1', ['a1']);

    expect(result.added, ['a1']);
    expect(result.failed, isEmpty);
  });

  test('not_found and unknown count as failures', () async {
    stubResponse([
      BulkIdResponseDto(id: 'a1', success: false, error: const Optional.present(BulkIdErrorReason.notFound)),
      BulkIdResponseDto(id: 'a2', success: false, error: const Optional.present(BulkIdErrorReason.unknown)),
    ]);

    final result = await repo.addAssets('album1', ['a1', 'a2']);

    expect(result.added, isEmpty);
    expect(result.failed, ['a1', 'a2']);
  });

  test('mixed: added kept, no_permission failed, duplicate dropped', () async {
    stubResponse([
      BulkIdResponseDto(id: 'ok', success: true),
      BulkIdResponseDto(id: 'perm', success: false, error: const Optional.present(BulkIdErrorReason.noPermission)),
      BulkIdResponseDto(id: 'dup', success: false, error: const Optional.present(BulkIdErrorReason.duplicate)),
    ]);

    final result = await repo.addAssets('album1', ['ok', 'perm', 'dup']);

    expect(result.added, ['ok']);
    expect(result.failed, ['perm']);
  });

  group('confirmPrivate', () {
    AlbumResponseDto albumResponse() => AlbumResponseDto(
      id: 'album1',
      albumName: 'Album',
      albumThumbnailAssetId: null,
      description: '',
      createdAt: DateTime(2026),
      updatedAt: DateTime(2026),
      assetCount: 0,
      hasSharedLink: false,
      isActivityEnabled: false,
      isPrivate: false,
      shared: false,
    );

    UserDto owner() => UserDto(
      id: 'user1',
      email: 'user@test.dev',
      name: 'user',
      memoryEnabled: true,
      profileChangedAt: DateTime(2026),
    );

    test('addAssets sends confirmPrivate only when asked to', () async {
      stubResponse([BulkIdResponseDto(id: 'a1', success: true)]);

      await repo.addAssets('album1', ['a1']);
      final plain =
          verify(
                () => api.addAssetsToAlbum('album1', captureAny(), abortTrigger: any(named: 'abortTrigger')),
              ).captured.single
              as AlbumAddAssetsDto;
      expect(plain.confirmPrivate.isPresent, isFalse);

      await repo.addAssets('album1', ['a1'], confirmPrivate: true);
      final confirmed =
          verify(
                () => api.addAssetsToAlbum('album1', captureAny(), abortTrigger: any(named: 'abortTrigger')),
              ).captured.single
              as AlbumAddAssetsDto;
      expect(confirmed.ids, ['a1']);
      expect(confirmed.confirmPrivate.value, isTrue);
    });

    test('createDriftAlbum sends confirmPrivate only when asked to', () async {
      when(() => api.createAlbum(any())).thenAnswer((_) async => albumResponse());

      await repo.createDriftAlbum('Album', owner(), assetIds: ['a1']);
      final plain = verify(() => api.createAlbum(captureAny())).captured.single as CreateAlbumDto;
      expect(plain.confirmPrivate.isPresent, isFalse);

      await repo.createDriftAlbum('Album', owner(), assetIds: ['a1'], confirmPrivate: true);
      final confirmed = verify(() => api.createAlbum(captureAny())).captured.single as CreateAlbumDto;
      expect(confirmed.assetIds.value, ['a1']);
      expect(confirmed.confirmPrivate.value, isTrue);
    });

    test('addUsers sends confirmPrivate only when asked to', () async {
      when(() => api.addUsersToAlbum(any(), any())).thenAnswer((_) async => albumResponse());

      await repo.addUsers('album1', ['user2']);
      final plain = verify(() => api.addUsersToAlbum('album1', captureAny())).captured.single as AddUsersDto;
      expect(plain.confirmPrivate.isPresent, isFalse);

      await repo.addUsers('album1', ['user2'], confirmPrivate: true);
      final confirmed = verify(() => api.addUsersToAlbum('album1', captureAny())).captured.single as AddUsersDto;
      expect(confirmed.albumUsers.single.userId, 'user2');
      expect(confirmed.confirmPrivate.value, isTrue);
    });
  });
}
