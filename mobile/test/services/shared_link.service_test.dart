import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/services/shared_link.service.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../service.mocks.dart';

class _MockSharedLinksApi extends Mock implements SharedLinksApi {}

void main() {
  late MockApiService apiService;
  late _MockSharedLinksApi sharedLinksApi;
  late SharedLinkService sut;

  setUpAll(() {
    registerFallbackValue(SharedLinkCreateDto(type: SharedLinkType.ALBUM));
  });

  setUp(() {
    apiService = MockApiService();
    sharedLinksApi = _MockSharedLinksApi();
    when(() => apiService.sharedLinksApi).thenReturn(sharedLinksApi);
    when(
      () => sharedLinksApi.createSharedLink(any(), abortTrigger: any(named: 'abortTrigger')),
    ).thenAnswer((_) async => null);
    sut = SharedLinkService(apiService);
  });

  Future<SharedLinkCreateDto> createdDto({String? albumId, List<String>? assetIds, bool confirmPrivate = false}) async {
    await sut.createSharedLink(
      showMeta: true,
      allowDownload: true,
      allowUpload: false,
      albumId: albumId,
      assetIds: assetIds,
      confirmPrivate: confirmPrivate,
    );
    return verify(
          () => sharedLinksApi.createSharedLink(captureAny(), abortTrigger: any(named: 'abortTrigger')),
        ).captured.single
        as SharedLinkCreateDto;
  }

  group('createSharedLink confirmPrivate', () {
    test('an album link forwards confirmPrivate only when the user confirmed', () async {
      final plain = await createdDto(albumId: 'album-1');
      expect(plain.type, SharedLinkType.ALBUM);
      expect(plain.albumId.value, 'album-1');
      expect(plain.confirmPrivate.isPresent, isFalse);

      final confirmed = await createdDto(albumId: 'album-1', confirmPrivate: true);
      expect(confirmed.confirmPrivate.value, isTrue);
    });

    test('an individual assets link forwards confirmPrivate only when the user confirmed', () async {
      final plain = await createdDto(assetIds: ['a1', 'a2']);
      expect(plain.type, SharedLinkType.INDIVIDUAL);
      expect(plain.assetIds.value, ['a1', 'a2']);
      expect(plain.confirmPrivate.isPresent, isFalse);

      final confirmed = await createdDto(assetIds: ['a1', 'a2'], confirmPrivate: true);
      expect(confirmed.confirmPrivate.value, isTrue);
    });
  });
}
