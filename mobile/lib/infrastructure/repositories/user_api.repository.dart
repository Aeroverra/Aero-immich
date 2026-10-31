import 'dart:typed_data';

import 'package:http/http.dart';
import 'package:immich_mobile/data/server/api_repository.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart' as domain;
import 'package:immich_mobile/infrastructure/utils/user.converter.dart';
import 'package:openapi/api.dart';

class UserApiRepository extends ApiRepository {
  final UsersApi _api;
  const UserApiRepository(this._api);

  Future<UserDto?> getMyUser() async {
    final (adminDto, preferenceDto) = await (_api.getMyUser(), _api.getMyPreferences()).wait;
    if (adminDto == null) {
      return null;
    }

    return UserConverter.fromAdminDto(adminDto, preferenceDto);
  }

  Future<int> getPrivateModeTimeout() async {
    final preferences = await checkNull(_api.getMyPreferences());
    return preferences.privateMode.timeoutMinutes;
  }

  Future<void> updatePrivateModeTimeout(int minutes) async {
    await checkNull(
      _api.updateMyPreferences(
        UserPreferencesUpdateDto(
          privateMode: Optional.present(PrivateModeUpdate(timeoutMinutes: Optional.present(minutes))),
        ),
      ),
    );
  }

  Future<String> createProfileImage({required String name, required Uint8List data}) async {
    final res = await checkNull(_api.createProfileImage(MultipartFile.fromBytes('file', data, filename: name)));
    return res.profileImagePath;
  }

  Future<List<UserDto>> getAll() async {
    final dto = await checkNull(_api.searchUsers());
    return dto.map(UserConverter.fromSimpleUserDto).toList();
  }

  Future<domain.DeletedReimportMode> getDeletedReimportMode() async {
    final dto = await checkNull(_api.getMyPreferences());
    return switch (dto.deletedReimport.mode) {
      DeletedReimportMode.trash => domain.DeletedReimportMode.trash,
      DeletedReimportMode.skip => domain.DeletedReimportMode.skip,
      DeletedReimportMode.album => domain.DeletedReimportMode.album,
    };
  }

  Future<void> setDeletedReimportMode(domain.DeletedReimportMode mode) async {
    final apiMode = switch (mode) {
      domain.DeletedReimportMode.trash => DeletedReimportMode.trash,
      domain.DeletedReimportMode.skip => DeletedReimportMode.skip,
      domain.DeletedReimportMode.album => DeletedReimportMode.album,
    };
    await checkNull(
      _api.updateMyPreferences(
        UserPreferencesUpdateDto(
          deletedReimport: Optional.present(DeletedReimportUpdate(mode: Optional.present(apiMode))),
        ),
      ),
    );
  }

  Future<int> getDeletedChecksumCount() async {
    final dto = await checkNull(_api.getMyDeletedChecksumStatistics());
    return dto.count;
  }

  Future<void> forgetDeletedChecksums() => _api.deleteMyDeletedChecksums();
}
