import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/routing/router.dart';

/// Lets the private folder open only while the session's private mode is on.
///
/// When it is off, the PIN page turns it on (with biometrics when enrolled, otherwise with
/// the PIN) and replaces itself with the folder.
class PrivateGuard extends AutoRouteGuard {
  final Ref _ref;

  PrivateGuard(this._ref);

  @override
  Future<void> onNavigation(NavigationResolver resolver, StackRouter router) async {
    if (_ref.read(privateModeProvider)) {
      resolver.next(true);
      return;
    }

    unawaited(router.push(PrivatePinAuthRoute(openPrivateFolder: true)));
  }
}
