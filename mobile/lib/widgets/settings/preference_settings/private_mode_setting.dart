import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_mobile/widgets/settings/setting_group_title.dart';
import 'package:immich_mobile/widgets/settings/setting_list_tile.dart';
import 'package:logging/logging.dart';

const int kPrivateModeTimeoutMin = 1;
const int kPrivateModeTimeoutMax = 1440;

/// The server-side `privateMode.timeoutMinutes` preference of the current user
final privateModeTimeoutProvider = FutureProvider.autoDispose<int>(
  (ref) => ref.watch(userApiRepositoryProvider).getPrivateModeTimeout(),
);

class PrivateModeSetting extends ConsumerWidget {
  const PrivateModeSetting({super.key});

  static final _log = Logger('PrivateModeSetting');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final timeout = ref.watch(privateModeTimeoutProvider);

    Future<void> editTimeout() async {
      final minutes = await showDialog<int>(
        context: context,
        builder: (context) => _PrivateModeTimeoutDialog(initialValue: timeout.valueOrNull),
      );
      if (minutes == null || !context.mounted) {
        return;
      }

      try {
        await ref.read(userApiRepositoryProvider).updatePrivateModeTimeout(minutes);
        ref.invalidate(privateModeTimeoutProvider);
      } catch (error, stack) {
        _log.warning('Failed to update the private mode timeout', error, stack);
        if (context.mounted) {
          ImmichToast.show(
            context: context,
            msg: context.t.error_saving_image(error: error),
            toastType: ToastType.error,
          );
        }
      }
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SettingGroupTitle(title: context.t.private_mode, icon: Icons.lock_person_outlined),
        SettingListTile(
          title: context.t.private_mode_timeout,
          subtitle: context.t.private_mode_timeout_description,
          trailing: timeout.when(
            data: (minutes) => Text(minutes.toString(), style: context.textTheme.titleMedium),
            loading: () => const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2)),
            error: (_, _) => const Icon(Icons.error_outline),
          ),
          onTap: timeout.hasValue ? editTimeout : null,
        ),
      ],
    );
  }
}

class _PrivateModeTimeoutDialog extends StatefulWidget {
  const _PrivateModeTimeoutDialog({this.initialValue});

  final int? initialValue;

  @override
  State<_PrivateModeTimeoutDialog> createState() => _PrivateModeTimeoutDialogState();
}

class _PrivateModeTimeoutDialogState extends State<_PrivateModeTimeoutDialog> {
  late final TextEditingController _controller = TextEditingController(text: widget.initialValue?.toString() ?? '');
  final _formKey = GlobalKey<FormState>();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  String? _validate(String? value) {
    final minutes = int.tryParse(value ?? '');
    if (minutes == null || minutes < kPrivateModeTimeoutMin || minutes > kPrivateModeTimeoutMax) {
      return '$kPrivateModeTimeoutMin - $kPrivateModeTimeoutMax';
    }
    return null;
  }

  void _save() {
    if (_formKey.currentState?.validate() != true) {
      return;
    }
    Navigator.of(context).pop(int.parse(_controller.text));
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(context.t.private_mode_timeout),
      content: Form(
        key: _formKey,
        child: TextFormField(
          controller: _controller,
          autofocus: true,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
          validator: _validate,
          autovalidateMode: AutovalidateMode.onUserInteraction,
          decoration: InputDecoration(
            helperText: context.t.private_mode_timeout_description,
            helperMaxLines: 3,
            border: const OutlineInputBorder(),
          ),
          onFieldSubmitted: (_) => _save(),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(context.t.cancel)),
        TextButton(onPressed: _save, child: Text(context.t.save)),
      ],
    );
  }
}
