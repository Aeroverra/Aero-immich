import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_mobile/widgets/settings/setting_group_title.dart';
import 'package:immich_mobile/widgets/settings/settings_radio_list_tile.dart';
import 'package:immich_mobile/widgets/settings/settings_sub_page_scaffold.dart';
import 'package:logging/logging.dart';

/// Whether actions on a selection with stacks include the stacked items, see the server-side stackActions preference
class StackActionsSettings extends HookConsumerWidget {
  const StackActionsSettings({super.key});

  static final _log = Logger('StackActionsSettings');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mode = useState(StackActionMode.ask);
    final userId = ref.watch(authUserProvider).id;

    useEffect(() {
      Future<void> load() async {
        final current = await ref.read(driftProvider).userMetadataRepository.getStackActionMode(userId);
        if (context.mounted) {
          mode.value = current;
        }
      }

      unawaited(load());
      return null;
    }, [userId]);

    Future<void> onModeChanged(StackActionMode? newMode) async {
      if (newMode == null || newMode == mode.value) {
        return;
      }

      final previous = mode.value;
      mode.value = newMode;
      try {
        await ref.read(userApiRepositoryProvider).setStackActionMode(newMode);
        await ref.read(driftProvider).userMetadataRepository.setStackActionMode(userId, newMode);
      } catch (error, stack) {
        _log.warning('Failed to update the stack actions preference', error, stack);
        mode.value = previous;
        if (context.mounted) {
          ImmichToast.show(
            context: context,
            msg: context.t.errors.unable_to_update_settings,
            toastType: ToastType.error,
          );
        }
      }
    }

    final settings = [
      SettingGroupTitle(
        title: context.t.stack_actions_mode,
        subtitle: context.t.stack_actions_mode_description,
        icon: Icons.burst_mode_outlined,
      ),
      SettingsRadioListTile<StackActionMode>(
        groups: [
          SettingsRadioGroup(title: context.t.stack_actions_mode_ask, value: StackActionMode.ask),
          SettingsRadioGroup(title: context.t.stack_actions_mode_primary, value: StackActionMode.primary),
          SettingsRadioGroup(title: context.t.stack_actions_mode_stack, value: StackActionMode.stack),
        ],
        groupBy: mode.value,
        onRadioChanged: onModeChanged,
      ),
    ];

    return SettingsSubPageScaffold(settings: settings);
  }
}
