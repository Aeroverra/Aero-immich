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

  test('adds a person to assets through the server', () async {
    when(() => api.addToAssets('ann', any())).thenAnswer((_) async => ['photo-1']);

    await expectLater(sut.addToAssets('ann', ['photo-1', 'video-1']), completion(['photo-1']));
    verify(() => api.addToAssets('ann', ['photo-1', 'video-1'])).called(1);
  });

  test('takes a person off assets and reports where a face keeps them', () async {
    when(() => api.removeFromAssets('ann', any())).thenAnswer((_) async => (removed: ['video-1'], kept: ['photo-1']));

    final result = await sut.removeFromAssets('ann', ['photo-1', 'video-1']);

    expect(result.removed, ['video-1']);
    expect(result.kept, ['photo-1']);
  });

  test('counts the people of assets', () async {
    when(() => api.getAssetCounts(any())).thenAnswer((_) async => {'ann': (count: 2, removable: 1)});

    await expectLater(sut.countOnAssets(['photo-1', 'video-1']), completion({'ann': (count: 2, removable: 1)}));
  });
}
