import 'dart:async';

import 'package:immich_mobile/data/db/main/dao/person.dart';
import 'package:immich_mobile/data/server/person.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';

/// Accesses People; entities mapped to assets for presence and face detection
class PeopleService {
  final PeopleRepository _repository;
  final PersonApiRepository _personApiRepository;

  const PeopleService(this._repository, this._personApiRepository);

  Future<Person?> get(String personId) {
    return _repository.get(personId);
  }

  Future<List<Person>> getAssetPeople(String assetId) {
    return _repository.getAssetPeople(assetId);
  }

  Stream<List<Person>> watch({int minFaces = 3, PrivateModeFilter privateFilter = PrivateModeFilter.off}) {
    return _repository.watch(minFaces: minFaces, privateFilter: privateFilter);
  }

  Future<int> updateName(String personId, String name) async {
    await _personApiRepository.update(personId, name: name);
    return _repository.updateName(personId, name);
  }

  Future<int> updateBirthday(String personId, DateTime birthday) async {
    await _personApiRepository.update(personId, birthday: birthday);
    return _repository.updateBirthday(personId, birthday);
  }

  /// Adds the person to [assetIds] without a face box; the new faces reach the local database with the next sync
  Future<List<String>> addToAssets(String personId, List<String> assetIds) {
    return _personApiRepository.addToAssets(personId, assetIds);
  }

  /// Takes the person off [assetIds]; a face of theirs found in the picture stays (reported as kept)
  Future<({List<String> removed, List<String> kept})> removeFromAssets(String personId, List<String> assetIds) {
    return _personApiRepository.removeFromAssets(personId, assetIds);
  }

  /// For every person on any of [assetIds]: how many of them they are on, and on how many a removal takes them off
  Future<Map<String, ({int count, int removable})>> countOnAssets(List<String> assetIds) {
    return _personApiRepository.getAssetCounts(assetIds);
  }
}
