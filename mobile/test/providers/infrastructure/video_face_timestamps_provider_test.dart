import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/providers/infrastructure/people.provider.dart';
import 'package:immich_mobile/utils/people.utils.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../../service.mocks.dart';

class MockFacesApi extends Mock implements FacesApi {}

AssetFaceResponseDto _face({String? personId, Optional<int?> frameTimestamp = const Optional.absent()}) =>
    AssetFaceResponseDto(
      boundingBoxX1: 0,
      boundingBoxX2: 10,
      boundingBoxY1: 0,
      boundingBoxY2: 10,
      frameTimestamp: frameTimestamp,
      id: 'face-${personId ?? 'none'}-$frameTimestamp',
      imageHeight: 100,
      imageWidth: 100,
      person: personId == null
          ? null
          : PersonResponseDto(birthDate: null, id: personId, isHidden: false, name: '', thumbnailPath: ''),
    );

void main() {
  group('groupFaceTimestampsByPerson', () {
    test('groups distinct sorted timestamps per person', () {
      final result = groupFaceTimestampsByPerson([
        _face(personId: 'a', frameTimestamp: const Optional.present(9000)),
        _face(personId: 'b', frameTimestamp: const Optional.present(500)),
        _face(personId: 'a', frameTimestamp: const Optional.present(1200)),
        _face(personId: 'a', frameTimestamp: const Optional.present(9000)),
        _face(personId: 'a', frameTimestamp: const Optional.present(0)),
      ]);

      expect(result, {
        'a': [0, 1200, 9000],
        'b': [500],
      });
    });

    test('skips thumbnail faces, unassigned faces and servers without the field', () {
      final result = groupFaceTimestampsByPerson([
        _face(personId: 'a', frameTimestamp: const Optional.present(null)),
        _face(personId: 'a'),
        _face(frameTimestamp: const Optional.present(3000)),
      ]);

      expect(result, isEmpty);
    });
  });

  group('videoFaceTimestampsProvider', () {
    late MockApiService apiService;
    late MockFacesApi facesApi;
    late ProviderContainer container;

    setUp(() {
      apiService = MockApiService();
      facesApi = MockFacesApi();
      when(() => apiService.facesApi).thenReturn(facesApi);
      container = ProviderContainer(overrides: [apiServiceProvider.overrideWithValue(apiService)]);
      addTearDown(container.dispose);
    });

    test('maps the faces of the asset', () async {
      when(() => facesApi.getFaces('asset-1')).thenAnswer(
        (_) async => [
          _face(personId: 'a', frameTimestamp: const Optional.present(4000)),
          _face(personId: 'a', frameTimestamp: const Optional.present(2000)),
          _face(personId: 'b', frameTimestamp: const Optional.present(null)),
        ],
      );

      final result = await container.listen(videoFaceTimestampsProvider('asset-1').future, (_, _) {}).read();

      expect(result, {
        'a': [2000, 4000],
      });
    });

    test('returns an empty map when the request fails', () async {
      when(() => facesApi.getFaces('asset-1')).thenThrow(ApiException(500, 'boom'));

      final result = await container.listen(videoFaceTimestampsProvider('asset-1').future, (_, _) {}).read();

      expect(result, isEmpty);
    });

    test('returns an empty map when the server returns nothing', () async {
      when(() => facesApi.getFaces('asset-1')).thenAnswer((_) async => null);

      final result = await container.listen(videoFaceTimestampsProvider('asset-1').future, (_, _) {}).read();

      expect(result, isEmpty);
    });
  });
}
