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

  /// Adds the person to [assetIds] without a face box. Returns the assets that got the person; the others already
  /// had them, or could not be changed.
  Future<List<String>> addToAssets(String id, List<String> assetIds) async {
    final results = await _api.addPersonToAssets(id, BulkIdsDto(ids: assetIds)) ?? const <BulkIdResponseDto>[];
    return [
      for (final result in results)
        if (result.success) result.id,
    ];
  }

  /// Takes the person off [assetIds]. Returns the assets they were removed from, and the ones they stay on because
  /// their face was found in the picture (those change in the face editor).
  Future<({List<String> removed, List<String> kept})> removeFromAssets(String id, List<String> assetIds) async {
    final results = await _api.removePersonFromAssets(id, BulkIdsDto(ids: assetIds)) ?? const <BulkIdResponseDto>[];
    return (
      removed: [
        for (final result in results)
          if (result.success) result.id,
      ],
      kept: [
        for (final result in results)
          if (result.error.orElse(null) == BulkIdErrorReason.validation) result.id,
      ],
    );
  }

  /// For every person on any of [assetIds]: how many of them they are on, and on how many a removal takes them off
  Future<Map<String, ({int count, int removable})>> getAssetCounts(List<String> assetIds) async {
    final counts =
        await _api.getPersonAssetCounts(PersonAssetCountsDto(assetIds: assetIds)) ??
        const <PersonAssetCountResponseDto>[];
    return {for (final count in counts) count.personId: (count: count.count, removable: count.removableCount)};
  }

  static Person _toPerson(PersonResponseDto dto) =>
      .new(birthDate: dto.birthDate, id: dto.id, name: dto.name, updatedAt: dto.updatedAt.orElse(null));
}
