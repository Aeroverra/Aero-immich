import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/models/auth/login_response.model.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/repositories/api.repository.dart';
import 'package:immich_mobile/services/api.service.dart';
import 'package:openapi/api.dart';

final authApiRepositoryProvider = Provider((ref) => AuthApiRepository(ref.watch(apiServiceProvider)));

class AuthApiRepository extends ApiRepository {
  final ApiService _apiService;

  AuthApiRepository(this._apiService);

  Future<void> changePassword(String newPassword) async {
    await _apiService.usersApi.updateMyUser(UserUpdateMeDto(password: Optional.present(newPassword)));
  }

  Future<LoginResponse> login(String email, String password) async {
    final loginResponseDto = await checkNull(
      _apiService.authenticationApi.login(LoginCredentialDto(email: email, password: password)),
    );

    return _mapLoginReponse(loginResponseDto);
  }

  Future<void> logout() async {
    if (_apiService.apiClient.basePath.isEmpty) {
      return;
    }

    await _apiService.authenticationApi.logout().timeout(const Duration(seconds: 7));
  }

  LoginResponse _mapLoginReponse(LoginResponseDto dto) {
    return LoginResponse(
      accessToken: dto.accessToken,
      isAdmin: dto.isAdmin,
      name: dto.name,
      profileImagePath: dto.profileImagePath,
      shouldChangePassword: dto.shouldChangePassword,
      userEmail: dto.userEmail,
      userId: dto.userId,
    );
  }

  Future<bool> unlockPinCode(String pinCode) async {
    try {
      await _apiService.authenticationApi.unlockAuthSession(SessionUnlockDto(pinCode: Optional.present(pinCode)));
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> setupPinCode(String pinCode) {
    return _apiService.authenticationApi.setupPinCode(PinCodeSetupDto(pinCode: pinCode));
  }

  Future<void> lockPinCode() {
    return _apiService.authenticationApi.lockAuthSession();
  }

  Future<bool> enablePrivateMode(String pinCode) async {
    try {
      await _apiService.authenticationApi.enablePrivateMode(SessionUnlockDto(pinCode: Optional.present(pinCode)));
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> disablePrivateMode() {
    if (_apiService.apiClient.basePath.isEmpty) {
      return Future.value();
    }
    return _apiService.authenticationApi.disablePrivateMode().timeout(const Duration(seconds: 7));
  }

  Future<PrivateModeStatus> getPrivateModeStatus() async {
    final status = await _apiService.authenticationApi.getAuthStatus();
    if (status == null) {
      return const PrivateModeStatus(enabled: false);
    }
    final expiresAt = status.privateModeExpiresAt.orElse(null);
    return PrivateModeStatus(
      enabled: status.privateMode,
      expiresAt: expiresAt == null ? null : DateTime.tryParse(expiresAt)?.toLocal(),
    );
  }
}
