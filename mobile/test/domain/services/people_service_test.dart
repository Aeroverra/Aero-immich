import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/dao/person.dart';
import 'package:immich_mobile/data/server/person.dart';
import 'package:immich_mobile/domain/services/people.service.dart';
import 'package:mocktail/mocktail.dart';

class _MockPeopleRepository extends Mock implements PeopleRepository {}

class _MockPersonApiRepository extends Mock implements PersonApiRepository {}

void main() {
  late _MockPersonApiRepository api;
  late PeopleService sut;

  setUp(() {
    api = _MockPersonApiRepository();
    sut = PeopleService(_MockPeopleRepository(), api);
  });

  group('tagOnVideos', () {
    test('tags every person and merges what the server reports', () async {
      when(() => api.addToAssets('ann', any())).thenAnswer((_) async => (tagged: ['video-1'], photos: ['photo-1']));
      when(
        () => api.addToAssets('bob', any()),
      ).thenAnswer((_) async => (tagged: ['video-1', 'video-2'], photos: ['photo-1']));

      final result = await sut.tagOnVideos(['ann', 'bob'], ['video-1', 'video-2', 'photo-1']);

      expect(result.tagged, {'video-1', 'video-2'});
      expect(result.photos, {'photo-1'});
      verify(() => api.addToAssets('ann', ['video-1', 'video-2', 'photo-1'])).called(1);
      verify(() => api.addToAssets('bob', ['video-1', 'video-2', 'photo-1'])).called(1);
    });

    test('reports nothing when no video got a person', () async {
      when(() => api.addToAssets(any(), any())).thenAnswer((_) async => (tagged: <String>[], photos: <String>[]));

      final result = await sut.tagOnVideos(['ann'], ['video-1']);

      expect(result.tagged, isEmpty);
      expect(result.photos, isEmpty);
    });
  });
}
