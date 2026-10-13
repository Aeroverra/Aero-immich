import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/providers/server_info.provider.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:logging/logging.dart';

/// Top bar toggle for the server-side stacks.groupAuto preference: automatic stacks grouped, or their photos shown
/// one by one. Manual stacks always stay grouped. Hidden when the server does not know the stack source.
class GroupAutoStacksButton extends ConsumerWidget {
  const GroupAutoStacksButton({super.key});

  static final _log = Logger('GroupAutoStacksButton');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isSupported = ref.watch(serverInfoProvider.select((state) => state.serverFeatures.stackSource));
    if (!isSupported) {
      return const SizedBox.shrink();
    }

    final groupAutoStacks = ref.watch(groupAutoStacksProvider);

    Future<void> toggle() async {
      try {
        await ref.read(updateGroupAutoStacksProvider)(!groupAutoStacks);
      } catch (error, stack) {
        _log.warning('Failed to update the automatic stacks preference', error, stack);
        if (context.mounted) {
          ImmichToast.show(
            context: context,
            msg: context.t.errors.unable_to_update_settings,
            toastType: ToastType.error,
          );
        }
      }
    }

    return IconButton(
      tooltip: groupAutoStacks ? context.t.show_automatic_stacks_as_separate_photos : context.t.group_automatic_stacks,
      isSelected: groupAutoStacks,
      onPressed: () => unawaited(toggle()),
      icon: const Icon(Icons.photo_library_outlined),
      selectedIcon: Icon(Icons.burst_mode_outlined, color: context.primaryColor),
    );
  }
}
