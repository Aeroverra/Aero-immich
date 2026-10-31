import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/repositories/custom_view_api.repository.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_mobile/widgets/forms/pin_verification_form.dart';
import 'package:logging/logging.dart';

final _log = Logger('CustomViewSwitcher');

/// Top bar button that switches the library between the user's custom views. Lists the default view, open and locked
/// views, and views with private access while private mode is unlocked. Hidden when the server does not know views or
/// the user has none.
class CustomViewSwitcherButton extends ConsumerWidget {
  const CustomViewSwitcherButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isSupported = ref.watch(customViewsSupportedProvider);
    final views = ref.watch(switchableViewsProvider);
    if (!isSupported || views.isEmpty) {
      return const SizedBox.shrink();
    }

    final applied = ref.watch(appliedViewProvider);
    final isSwitched = applied != null && !applied.isDefault;

    return IconButton(
      key: const Key('custom-view-switcher'),
      tooltip: context.t.custom_view_switcher_title(name: applied?.name ?? context.t.custom_view_all_photos),
      isSelected: isSwitched,
      onPressed: () => unawaited(showCustomViewSwitcher(context)),
      icon: const Icon(Icons.filter_alt_outlined),
      selectedIcon: Icon(Icons.filter_alt, color: context.primaryColor),
    );
  }
}

Future<void> showCustomViewSwitcher(BuildContext context) {
  return showModalBottomSheet(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    builder: (_) => const CustomViewSwitcherSheet(),
  );
}

class CustomViewSwitcherSheet extends ConsumerWidget {
  const CustomViewSwitcherSheet({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final views = ref.watch(switchableViewsProvider);
    final applied = ref.watch(appliedViewProvider);

    Future<void> onTap(CustomView view) async {
      if (view.id == applied?.id) {
        Navigator.of(context).pop();
        return;
      }
      final switched = await switchToCustomView(context, ref, view);
      if (switched && context.mounted) {
        Navigator.of(context).pop();
      }
    }

    return SingleChildScrollView(
      child: Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 20, 24, 8),
              child: Text(context.t.custom_views, style: context.textTheme.titleMedium),
            ),
            for (final view in views)
              ListTile(
                key: Key('custom-view-${view.id}'),
                leading: Icon(view.id == applied?.id ? Icons.check_rounded : null, color: context.primaryColor),
                title: Text(view.name),
                subtitle: view.isDefault ? Text(context.t.custom_view_default) : null,
                trailing: switch (view.access) {
                  _ when view.isDefault => null,
                  ViewAccess.open => null,
                  ViewAccess.locked => Tooltip(
                    message: context.t.custom_view_access_locked,
                    child: const Icon(Icons.lock_outline_rounded),
                  ),
                  ViewAccess.private => Tooltip(
                    message: context.t.custom_view_access_private,
                    child: const Icon(Icons.lock_person_outlined),
                  ),
                },
                selected: view.id == applied?.id,
                onTap: () => unawaited(onTap(view)),
              ),
          ],
        ),
      ),
    );
  }
}

/// Switches the library to [view]. A locked view asks for biometrics (the enrolment shared with private mode and the
/// locked folder) or the PIN code on every switch; the default view never needs either. Returns whether it switched.
Future<bool> switchToCustomView(BuildContext context, WidgetRef ref, CustomView view) async {
  final notifier = ref.read(activeViewProvider.notifier);

  void showError() {
    if (context.mounted) {
      ImmichToast.show(
        context: context,
        msg: context.t.errors.unable_to_switch_custom_view,
        toastType: ToastType.error,
      );
    }
  }

  try {
    if (view.isDefault || view.access != ViewAccess.locked) {
      await notifier.switchTo(view);
      return true;
    }

    final result = await notifier.switchWithBiometrics(view);
    if (result == ViewBiometricResult.switched) {
      return true;
    }
    if (!context.mounted) {
      return false;
    }
    return await _askPin(context, notifier, view);
  } catch (error, stack) {
    _log.warning('Failed to switch to view ${view.id}', error, stack);
    showError();
    return false;
  }
}

Future<bool> _askPin(BuildContext context, ActiveViewNotifier notifier, CustomView view) async {
  final switched = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => SimpleDialog(
      title: Text(context.t.custom_view_switch_locked_title(name: view.name)),
      children: [
        Padding(
          padding: const EdgeInsets.all(16),
          child: PinVerificationForm(
            autoFocus: true,
            description: context.t.custom_view_switch_locked_description,
            icon: Icons.lock_outline_rounded,
            successIcon: Icons.lock_open_rounded,
            verify: (pinCode) async {
              try {
                await notifier.switchTo(view, pinCode: pinCode);
                return true;
              } catch (error, stack) {
                // a wrong PIN shakes the form; anything else is logged, the form stays open to try again
                if (error is! CustomViewSwitchException || error.error == CustomViewSwitchError.notFound) {
                  _log.warning('Failed to switch to view ${view.id} with the PIN code', error, stack);
                }
                return false;
              }
            },
            onSuccess: (_) => Navigator.of(dialogContext).pop(true),
          ),
        ),
      ],
    ),
  );
  return switched ?? false;
}
