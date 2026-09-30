import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/services/screen_state.service.dart';
import 'package:immich_mobile/widgets/settings/setting_group_title.dart';
import 'package:immich_mobile/widgets/settings/settings_radio_list_tile.dart';

/// Picks when the app locks private mode, or returns to the default view, again.
///
/// "Lock when the screen turns off" is only offered where the platform reports the screen turning off; everywhere
/// else it behaves like the stricter "lock when leaving the app", so the option is left out.
class LockTriggerSetting extends ConsumerWidget {
  const LockTriggerSetting({
    super.key,
    required this.title,
    required this.description,
    required this.icon,
    required this.trigger,
    required this.onChanged,
  });

  final String title;
  final String description;
  final IconData icon;
  final LockTrigger trigger;
  final void Function(LockTrigger trigger) onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final screenOffReported = ref.watch(screenOffReportedProvider).valueOrNull ?? true;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SettingGroupTitle(title: title, subtitle: description, icon: icon),
        SettingsRadioListTile<LockTrigger>(
          groups: [
            SettingsRadioGroup(
              title: context.t.lock_trigger_app_pause,
              subtitle: context.t.lock_trigger_app_pause_description,
              value: LockTrigger.appPause,
            ),
            if (screenOffReported || trigger == LockTrigger.screenOff)
              SettingsRadioGroup(
                title: context.t.lock_trigger_screen_off,
                subtitle: context.t.lock_trigger_screen_off_description,
                value: LockTrigger.screenOff,
              ),
            SettingsRadioGroup(
              title: context.t.lock_trigger_timeout,
              subtitle: context.t.lock_trigger_timeout_description,
              value: LockTrigger.timeout,
            ),
          ],
          groupBy: trigger,
          onRadioChanged: (value) {
            if (value != null && value != trigger) {
              onChanged(value);
            }
          },
        ),
      ],
    );
  }
}
