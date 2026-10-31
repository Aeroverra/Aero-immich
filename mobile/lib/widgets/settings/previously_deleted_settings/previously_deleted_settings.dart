import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_mobile/widgets/settings/setting_group_title.dart';
import 'package:immich_mobile/widgets/settings/settings_button_list_tile.dart';
import 'package:immich_mobile/widgets/settings/settings_radio_list_tile.dart';
import 'package:immich_mobile/widgets/settings/settings_sub_page_scaffold.dart';
import 'package:logging/logging.dart';

/// Decides what happens when a file the user permanently deleted is uploaded again.
/// The preference and the remembered files live on the server, not in the local settings.
class PreviouslyDeletedSettings extends HookConsumerWidget {
  const PreviouslyDeletedSettings({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final log = Logger('PreviouslyDeletedSettings');
    final repository = ref.watch(userApiRepositoryProvider);
    final mode = useState<DeletedReimportMode?>(null);
    final count = useState<int?>(null);

    useEffect(() {
      Future<void> load() async {
        try {
          final (currentMode, currentCount) = await (
            repository.getDeletedReimportMode(),
            repository.getDeletedChecksumCount(),
          ).wait;
          if (!context.mounted) {
            return;
          }
          mode.value = currentMode;
          count.value = currentCount;
        } catch (error, stack) {
          log.warning('Failed to load the previously deleted files settings', error, stack);
          if (context.mounted) {
            ImmichToast.show(
              context: context,
              msg: context.t.errors.unable_to_load_previously_deleted_files,
              toastType: ToastType.error,
            );
          }
        }
      }

      unawaited(load());
      return null;
    }, const []);

    Future<void> onModeChanged(DeletedReimportMode? newMode) async {
      if (newMode == null || newMode == mode.value) {
        return;
      }

      final previous = mode.value;
      mode.value = newMode;
      try {
        await repository.setDeletedReimportMode(newMode);
      } catch (error, stack) {
        log.warning('Failed to update the previously deleted files mode', error, stack);
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

    Future<void> onForgetAll() async {
      await showDialog(
        context: context,
        builder: (dialogContext) => ConfirmDialog(
          title: context.t.previously_deleted_forget_all(count: count.value ?? 0),
          content: context.t.previously_deleted_forget_all_confirmation(count: count.value ?? 0),
          onOk: () async {
            try {
              await repository.forgetDeletedChecksums();
              count.value = 0;
              if (context.mounted) {
                ImmichToast.show(
                  context: context,
                  msg: context.t.previously_deleted_forgotten,
                  toastType: ToastType.success,
                );
              }
            } catch (error, stack) {
              log.warning('Failed to forget the previously deleted files', error, stack);
              if (context.mounted) {
                ImmichToast.show(
                  context: context,
                  msg: context.t.errors.unable_to_forget_previously_deleted_files,
                  toastType: ToastType.error,
                );
              }
            }
          },
        ),
      );
    }

    final settings = [
      SettingGroupTitle(
        title: context.t.previously_deleted_mode,
        subtitle: context.t.previously_deleted_mode_description,
        icon: Icons.restore_from_trash_outlined,
      ),
      SettingsRadioListTile<DeletedReimportMode>(
        groups: [
          SettingsRadioGroup(title: context.t.previously_deleted_mode_trash, value: DeletedReimportMode.trash),
          SettingsRadioGroup(title: context.t.previously_deleted_mode_skip, value: DeletedReimportMode.skip),
          SettingsRadioGroup(title: context.t.previously_deleted_mode_album, value: DeletedReimportMode.album),
        ],
        groupBy: mode.value ?? DeletedReimportMode.trash,
        onRadioChanged: onModeChanged,
      ),
      SettingsButtonListTile(
        icon: Icons.history,
        title: context.t.previously_deleted_files,
        subtileText: context.t.previously_deleted_remembered_files(count: count.value ?? 0),
        buttonText: context.t.previously_deleted_forget_all(count: count.value ?? 0),
        onButtonTap: (count.value ?? 0) > 0 ? onForgetAll : null,
      ),
    ];

    return SettingsSubPageScaffold(settings: settings);
  }
}
