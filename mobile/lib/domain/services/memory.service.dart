import 'package:immich_mobile/domain/models/memory.model.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/infrastructure/repositories/memory.repository.dart';
import 'package:logging/logging.dart';

/// Accesses Memories; a specialized collection of assets with some novel display mechanism
class MemoryService {
  final log = Logger("MemoryService");

  final MemoryRepository _repository;

  MemoryService(this._repository);

  Future<List<Memory>> getMemoryLane(String ownerId, {PrivateModeFilter privateFilter = PrivateModeFilter.off}) {
    return _repository.getAll(ownerId, privateFilter: privateFilter);
  }

  Future<List<Memory>> getAll(
    String ownerId, {
    bool onlyFavorites = false,
    PrivateModeFilter privateFilter = PrivateModeFilter.off,
  }) {
    return _repository.getAll(ownerId, onlyToday: false, onlyFavorites: onlyFavorites, privateFilter: privateFilter);
  }

  Future<Memory?> get(String memoryId, {PrivateModeFilter privateFilter = PrivateModeFilter.off}) {
    return _repository.get(memoryId, privateFilter: privateFilter);
  }

  Future<int> getCount() {
    return _repository.getCount();
  }
}
