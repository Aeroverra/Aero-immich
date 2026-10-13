import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:logging/logging.dart';

final _log = Logger('StackSelection');

/// The answer of [StackSelectionDialog]
class StackSelectionChoice {
  final bool includeStacked;
  final bool remember;

  const StackSelectionChoice({required this.includeStacked, required this.remember});
}

/// A collapsed stack only shows its primary asset, so an action on a selection with stacks either applies to
/// those primary assets or to every asset of the stacks. The server-side stackActions preference decides, or the
/// user is asked.
///
/// Returns the stacked assets to act on in addition to [assets] (empty when there are none or the user keeps the
/// top items only), or null when the user cancels. Only the timeline selection is resolved: the viewer shows the
/// stack members one by one.
Future<List<RemoteAsset>?> resolveStackedAssets(
  BuildContext context,
  WidgetRef ref,
  ActionSource source,
  Iterable<BaseAsset> assets,
) async {
  if (source != ActionSource.timeline) {
    return const [];
  }

  final selected = assets.whereType<RemoteAsset>().toList(growable: false);
  final stackIds = selected.map((asset) => asset.stackId).nonNulls.toSet();
  if (stackIds.isEmpty) {
    return const [];
  }

  final drift = ref.read(driftProvider);
  final selectedIds = selected.map((asset) => asset.id).toSet();
  // automatic stacks shown ungrouped are separate photos, nothing is hidden behind them
  final stacked = (await drift.remoteAssetRepository.getStackAssets(
    stackIds,
    includeAutoStacks: ref.read(groupAutoStacksProvider),
  )).where((asset) => !selectedIds.contains(asset.id)).toList(growable: false);
  if (stacked.isEmpty) {
    return const [];
  }

  final userId = ref.read(authUserProvider).id;
  var mode = await drift.userMetadataRepository.getStackActionMode(userId);
  if (mode == StackActionMode.ask) {
    if (!context.mounted) {
      return null;
    }

    final stackCount = stacked.map((asset) => asset.stackId).toSet().length;
    final choice = await showDialog<StackSelectionChoice>(
      context: context,
      builder: (_) => StackSelectionDialog(stackCount: stackCount),
    );
    if (choice == null) {
      return null;
    }

    mode = choice.includeStacked ? StackActionMode.stack : StackActionMode.primary;
    if (choice.remember) {
      try {
        await ref.read(userApiRepositoryProvider).setStackActionMode(mode);
        await drift.userMetadataRepository.setStackActionMode(userId, mode);
      } catch (error, stack) {
        // the action still goes ahead with the choice, only remembering it failed
        _log.warning('Failed to remember the stack action choice', error, stack);
        if (context.mounted) {
          await ref.read(toastServiceProvider).error(context.t.errors.unable_to_update_settings);
        }
      }
    }
  }

  return mode == StackActionMode.stack ? stacked : const [];
}

/// Asks whether an action applies to the top items of the selected stacks only or to their stacked items too
class StackSelectionDialog extends StatefulWidget {
  final int stackCount;

  const StackSelectionDialog({super.key, required this.stackCount});

  @override
  State<StackSelectionDialog> createState() => _StackSelectionDialogState();
}

class _StackSelectionDialogState extends State<StackSelectionDialog> {
  bool _remember = false;

  void _choose(bool includeStacked) =>
      Navigator.of(context).pop(StackSelectionChoice(includeStacked: includeStacked, remember: _remember));

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(10))),
      title: Text(context.t.stack_actions_prompt_title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(context.t.stack_actions_prompt_description(count: widget.stackCount)),
          const SizedBox(height: 12),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: _remember,
            onChanged: (value) => setState(() => _remember = value ?? false),
            title: Text(context.t.stack_actions_remember),
            subtitle: Text(context.t.stack_actions_remember_description),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(context.t.cancel)),
        TextButton(onPressed: () => _choose(false), child: Text(context.t.stack_actions_mode_primary)),
        TextButton(
          onPressed: () => _choose(true),
          child: Text(
            context.t.stack_actions_mode_stack,
            style: TextStyle(color: context.primaryColor, fontWeight: FontWeight.bold),
          ),
        ),
      ],
    );
  }
}
