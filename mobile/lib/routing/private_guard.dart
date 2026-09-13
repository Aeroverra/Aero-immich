import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/services/local_auth.service.dart';
import 'package:immich_mobile/services/secure_storage.service.dart';
import 'package:local_auth/error_codes.dart' as auth_error;
import 'package:logging/logging.dart';

/// Lets the private folder open only while the session's private mode is on.
///
/// When it is off, the stored PIN + biometrics turn it on in place (same path as the locked
/// folder); without a stored PIN the PIN form is shown and replaces itself with the folder.
class PrivateGuard extends AutoRouteGuard {
  final Ref _ref;
  final SecureStorageService _secureStorageService;
  final LocalAuthService _localAuth;
  final _log = Logger("PrivateGuard");

  PrivateGuard(this._ref, this._secureStorageService, this._localAuth);

  @override
  Future<void> onNavigation(NavigationResolver resolver, StackRouter router) async {
    if (_ref.read(privateModeProvider)) {
      resolver.next(true);
      return;
    }

    /// A PIN in secure storage means the user enabled biometric authentication
    final securePinCode = await _secureStorageService.read(kSecuredPinCode);
    if (securePinCode == null) {
      unawaited(router.push(PrivatePinAuthRoute(openPrivateFolder: true)));
      return;
    }

    try {
      final bool isAuth = await _localAuth.authenticate();

      if (!isAuth) {
        resolver.next(false);
        return;
      }

      final enabled = await _ref.read(privateModeProvider.notifier).enable(securePinCode);
      if (enabled) {
        resolver.next(true);
        return;
      }

      // PIN code has changed, need to re-enter to access
      await _secureStorageService.delete(kSecuredPinCode);
      unawaited(router.push(PrivatePinAuthRoute(openPrivateFolder: true)));
    } on PlatformException catch (error) {
      switch (error.code) {
        case auth_error.notAvailable:
          _log.severe("notAvailable: $error");
        case auth_error.notEnrolled:
          _log.severe("not enrolled");
        default:
          _log.severe("error");
      }

      resolver.next(false);
    } catch (error) {
      _log.severe("Failed to access private page", error);
      resolver.next(false);
    }
  }
}
