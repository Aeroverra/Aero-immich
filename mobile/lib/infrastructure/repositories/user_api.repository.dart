import 'dart:convert';
import 'dart:io';
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

  Future<void> updatePrivateModeLockTrigger(domain.LockTrigger trigger) async {
    await checkNull(
      _api.updateMyPreferences(
        UserPreferencesUpdateDto(
          privateMode: Optional.present(PrivateModeUpdate(lockTrigger: Optional.present(trigger.toDto()))),
        ),
      ),
    );
  }

  Future<void> updateCustomViewLockTrigger(domain.LockTrigger trigger) async {
    await checkNull(
      _api.updateMyPreferences(
        UserPreferencesUpdateDto(
          customViews: Optional.present(CustomViewsUpdate(lockTrigger: Optional.present(trigger.toDto()))),
        ),
      ),
    );
  }

  Future<void> updateGroupAutoStacks(bool groupAuto) async {
    await checkNull(
      _api.updateMyPreferences(
        UserPreferencesUpdateDto(stacks: Optional.present(StacksUpdate(groupAuto: Optional.present(groupAuto)))),
      ),
    );
  }

  /// Whether similar photos are stacked automatically for the user, or null when the server has no automatic stacks
  Future<bool?> getAutoStackEnabled() async {
    // the raw response: the generated model fills in a default for servers without the preference
    final response = await _api.getMyPreferencesWithHttpInfo();
    final body = utf8.decode(response.bodyBytes);
    if (response.statusCode >= HttpStatus.badRequest) {
      throw ApiException(response.statusCode, body);
    }

    final autoStack = (jsonDecode(body) as Map<String, dynamic>)['autoStack'];
    return autoStack is Map<String, dynamic> ? autoStack['enabled'] as bool? : null;
  }

  Future<void> updateAutoStackEnabled(bool enabled) async {
    await checkNull(
      _api.updateMyPreferences(
        UserPreferencesUpdateDto(autoStack: Optional.present(AutoStackUpdate(enabled: Optional.present(enabled)))),
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

  Future<void> setStackActionMode(domain.StackActionMode mode) async {
    final apiMode = switch (mode) {
      domain.StackActionMode.ask => StackActionMode.ask,
      domain.StackActionMode.primary => StackActionMode.primary,
      domain.StackActionMode.stack => StackActionMode.stack,
    };
    await checkNull(
      _api.updateMyPreferences(
        UserPreferencesUpdateDto(stackActions: Optional.present(StackActionsUpdate(mode: Optional.present(apiMode)))),
      ),
    );
  }

  Future<int> getDeletedChecksumCount() async {
    final dto = await checkNull(_api.getMyDeletedChecksumStatistics());
    return dto.count;
  }

  Future<void> forgetDeletedChecksums() => _api.deleteMyDeletedChecksums();
}

extension on domain.LockTrigger {
  LockTrigger toDto() => switch (this) {
    domain.LockTrigger.appPause => LockTrigger.appPause,
    domain.LockTrigger.screenOff => LockTrigger.screenOff,
    domain.LockTrigger.timeout => LockTrigger.timeout,
  };
}
