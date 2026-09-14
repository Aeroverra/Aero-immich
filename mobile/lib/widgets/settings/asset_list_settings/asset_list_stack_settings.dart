import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/server_capability.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/providers/server_info.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_mobile/widgets/settings/settings_switch_list_tile.dart';
import 'package:logging/logging.dart';

/// The server-side stacks.groupAuto preference: automatic stacks grouped, or their photos shown one by one.
/// Manual stacks always stay grouped. Hidden when the server does not know the stack source.
class StackSettings extends HookConsumerWidget {
  const StackSettings({super.key});

  static final _log = Logger('StackSettings');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isSupported = ref.watch(serverInfoProvider.select((state) => state.serverVersion.supports(.stacksV2)));
    final groupAutoStacks = ref.watch(groupAutoStacksProvider);
    final valueNotifier = useValueNotifier(groupAutoStacks);

    useEffect(() {
      valueNotifier.value = groupAutoStacks;
      return null;
    }, [groupAutoStacks]);

    Future<void> onChanged(bool value) async {
      try {
        await ref.read(userApiRepositoryProvider).updateGroupAutoStacks(value);
        final userId = ref.read(currentUserProvider)?.id;
        if (userId != null) {
          await ref.read(driftProvider).userMetadataRepository.setGroupAutoStacks(userId, value);
        }
      } catch (error, stack) {
        _log.warning('Failed to update the automatic stacks preference', error, stack);
        valueNotifier.value = !value;
        if (context.mounted) {
          ImmichToast.show(
            context: context,
            msg: context.t.errors.unable_to_update_settings,
            toastType: ToastType.error,
          );
        }
      }
    }

    if (!isSupported) {
      return const SizedBox.shrink();
    }

    return SettingsSwitchListTile(
      valueNotifier: valueNotifier,
      title: context.t.group_automatic_stacks,
      subtitle: context.t.group_automatic_stacks_description,
      onChanged: onChanged,
    );
  }
}
