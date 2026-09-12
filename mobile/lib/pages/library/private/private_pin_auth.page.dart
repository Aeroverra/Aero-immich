import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/local_auth.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/widgets/forms/pin_registration_form.dart';
import 'package:immich_mobile/widgets/forms/pin_verification_form.dart';

/// Asks for the PIN code to turn the session's private mode on.
///
/// With [openPrivateFolder] the page replaces itself with the private folder once the mode
/// is on (used by the route guard); otherwise it just pops (used by the app bar toggle).
@RoutePage()
class PrivatePinAuthPage extends HookConsumerWidget {
  final bool openPrivateFolder;

  const PrivatePinAuthPage({super.key, this.openPrivateFolder = false});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final localAuthState = ref.watch(localAuthProvider);
    final showPinRegistrationForm = useState(false);
    final authStatus = useFuture(
      useMemoized(() => ref.read(apiServiceProvider).authenticationApi.getAuthStatus().catchError((_) => null)),
    );

    useEffect(() {
      final status = authStatus.data;
      if (status != null && !status.pinCode) {
        showPinRegistrationForm.value = true;
      }
      return null;
    }, [authStatus.data]);

    Future<void> onEnabled() async {
      if (openPrivateFolder) {
        await context.replaceRoute(const PrivateFolderRoute());
        return;
      }
      await context.maybePop();
    }

    Future<bool> enablePrivateMode(String pinCode) {
      return ref.read(authProvider.notifier).enablePrivateMode(pinCode);
    }

    Future<void> registerBiometric(String pinCode) async {
      final isRegistered = await ref.read(localAuthProvider.notifier).registerBiometric(context, pinCode);

      if (!isRegistered || !context.mounted) {
        return;
      }

      context.showSnackBar(
        SnackBar(
          content: Text(context.t.biometric_auth_enabled, style: context.textTheme.labelLarge),
          duration: const Duration(seconds: 3),
          backgroundColor: context.colorScheme.primaryContainer,
        ),
      );

      unawaited(onEnabled());
    }

    Future<void> enableBiometricAuth() {
      return showDialog(
        context: context,
        builder: (buildContext) {
          return SimpleDialog(
            children: [
              Container(
                padding: const EdgeInsets.all(16),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    PinVerificationForm(
                      description: context.t.enable_biometric_auth_description,
                      verify: enablePrivateMode,
                      onSuccess: (pinCode) {
                        Navigator.pop(buildContext);
                        unawaited(registerBiometric(pinCode));
                      },
                      autoFocus: true,
                      icon: Icons.fingerprint_rounded,
                      successIcon: Icons.fingerprint_rounded,
                    ),
                  ],
                ),
              ),
            ],
          );
        },
      );
    }

    return Scaffold(
      appBar: AppBar(title: Text(context.t.private_mode)),
      body: ListView(
        shrinkWrap: true,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 36.0),
            child: showPinRegistrationForm.value
                ? Center(child: PinRegistrationForm(onDone: () => showPinRegistrationForm.value = false))
                : Column(
                    children: [
                      Center(
                        child: PinVerificationForm(
                          autoFocus: true,
                          description: context.t.private_mode_enable_description,
                          icon: Icons.lock_person_outlined,
                          verify: enablePrivateMode,
                          onSuccess: (_) => unawaited(onEnabled()),
                        ),
                      ),
                      const SizedBox(height: 24),
                      if (localAuthState.canAuthenticate) ...[
                        Padding(
                          padding: const EdgeInsets.only(right: 16.0),
                          child: TextButton.icon(
                            icon: const Icon(Icons.fingerprint, size: 28),
                            onPressed: () => unawaited(enableBiometricAuth()),
                            label: Text(
                              context.t.use_biometric,
                              style: context.textTheme.labelLarge?.copyWith(color: context.primaryColor, fontSize: 18),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}
