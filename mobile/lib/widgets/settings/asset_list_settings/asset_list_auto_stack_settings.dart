import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_mobile/widgets/settings/settings_switch_list_tile.dart';
import 'package:logging/logging.dart';

/// The server-side autoStack.enabled preference: whether the server stacks similar photos taken close together.
/// Hidden until the preference is loaded and for servers without automatic stacks.
class AutoStackSettings extends HookConsumerWidget {
  const AutoStackSettings({super.key});

  static final _log = Logger('AutoStackSettings');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repository = ref.watch(userApiRepositoryProvider);
    final isSupported = useState(false);
    final valueNotifier = useValueNotifier(false);
    // the switch tile reads the notifier without listening, so rebuild when it changes
    useValueListenable(valueNotifier);

    useEffect(() {
      Future<void> load() async {
        try {
          final enabled = await repository.getAutoStackEnabled();
          if (!context.mounted || enabled == null) {
            return;
          }
          valueNotifier.value = enabled;
          isSupported.value = true;
        } catch (error, stack) {
          _log.warning('Failed to load the automatic stacks preference', error, stack);
        }
      }

      unawaited(load());
      return null;
    }, const []);

    Future<void> onChanged(bool value) async {
      try {
        await repository.updateAutoStackEnabled(value);
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

    if (!isSupported.value) {
      return const SizedBox.shrink();
    }

    return SettingsSwitchListTile(
      valueNotifier: valueNotifier,
      title: context.t.stack_similar_photos_automatically,
      subtitle: context.t.stack_similar_photos_automatically_description,
      onChanged: onChanged,
    );
  }
}
