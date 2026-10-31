import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/providers/tagging.provider.dart';
import 'package:immich_mobile/utils/error_handler.dart';

/// Removes the tag [tagId] from the user's selected assets, used by the tag review page
class RemoveTagAction extends AssetActionBuilder {
  final String tagId;

  const RemoveTagAction({required super.source, required this.tagId});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    final assetIds = ref.watch(ownedAssetsActionProvider(source)).map((asset) => asset.id).toList(growable: false);
    if (assetIds.isEmpty) {
      return null;
    }

    return .new(
      icon: Icons.label_off_outlined,
      label: context.t.remove_tag,
      onAction: () => _remove(context, ref, assetIds),
    );
  }

  Future<void> _remove(BuildContext context, WidgetRef ref, List<String> assetIds) async {
    final clearSelection = ref.read(clearSelectionProvider(source));
    final toastService = ref.read(toastServiceProvider);
    final message = context.t.removed_tagged_assets(count: assetIds.length);
    try {
      await ref.read(taggingServiceProvider).removeTag(tagId, assetIds);
      clearSelection();
      toastService.success(message);
    } catch (error, stack) {
      handleError(error, stack: stack, description: 'Failed to remove the tag');
    }
  }
}
