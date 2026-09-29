import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/api_repository.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:openapi/api.dart';

final personApiRepositoryProvider = Provider((ref) => PersonApiRepository(ref.watch(apiServiceProvider).peopleApi));

class PersonApiRepository extends ApiRepository {
  final PeopleApi _api;

  const PersonApiRepository(this._api);

  Future<Person> update(String id, {String? name, DateTime? birthday}) async {
    final birthdayUtc = birthday == null ? null : DateTime.utc(birthday.year, birthday.month, birthday.day);
    final dto = PersonUpdateDto(
      name: name == null ? const Optional.absent() : Optional.present(name),
      birthDate: birthdayUtc == null ? const Optional.absent() : Optional.present(birthdayUtc),
    );
    final response = await checkNull(_api.updatePerson(id, dto));
    return _toPerson(response);
  }

  /// Tags the person on the videos among [assetIds] with a whole-frame face. Returns the assets that got the person
  /// and the photos the server left out (their faces are drawn on the photo instead).
  Future<({List<String> tagged, List<String> photos})> addToAssets(String id, List<String> assetIds) async {
    final results = await _api.addPersonToAssets(id, BulkIdsDto(ids: assetIds)) ?? const <BulkIdResponseDto>[];
    return (
      tagged: [
        for (final result in results)
          if (result.success) result.id,
      ],
      photos: [
        for (final result in results)
          if (result.error.orElse(null) == BulkIdErrorReason.validation) result.id,
      ],
    );
  }

  static Person _toPerson(PersonResponseDto dto) =>
      .new(birthDate: dto.birthDate, id: dto.id, name: dto.name, updatedAt: dto.updatedAt.orElse(null));
}
