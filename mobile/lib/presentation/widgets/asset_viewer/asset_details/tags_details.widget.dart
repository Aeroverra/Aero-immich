import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/tags/tag_assets_sheet.widget.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/providers/tagging.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:logging/logging.dart';

final _log = Logger('TagsDetails');

/// The tags of the asset as chips that remove the tag, plus a chip that opens the tag sheet. Hidden tags are left out
/// while private mode is locked. Only for the user's own uploaded assets on servers with custom views.
class TagsDetails extends ConsumerWidget {
  final BaseAsset asset;

  const TagsDetails({super.key, required this.asset});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tagsEnabled = ref.watch(
      userMetadataPreferencesProvider.select((value) => value.valueOrNull?.tagsEnabled ?? false),
    );
    final isSupported = ref.watch(customViewsSupportedProvider);
    final userId = ref.watch(currentUserProvider.select((user) => user?.id));
    final remote = switch (asset) {
      final RemoteAsset remote => (id: remote.id, ownerId: remote.ownerId),
      LocalAsset(:final remoteAssetId) when remoteAssetId != null => (id: remoteAssetId, ownerId: userId),
      _ => null,
    };
    if (!tagsEnabled || !isSupported || remote == null || remote.ownerId != userId) {
      return const SizedBox.shrink();
    }

    final tags = ref.watch(assetTagsProvider(remote.id)).valueOrNull ?? const <TagEntry>[];

    Future<void> remove(TagEntry tag) async {
      try {
        await ref.read(taggingServiceProvider).removeTag(tag.id, [remote.id]);
      } catch (error, stack) {
        _log.warning('Failed to remove tag ${tag.id}', error, stack);
        if (context.mounted) {
          ImmichToast.show(context: context, msg: context.t.errors.failed_to_tag_assets, toastType: ToastType.error);
        }
      }
    }

    return Padding(
      padding: const EdgeInsets.only(left: 16.0, right: 16.0, top: 16.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        spacing: 8,
        children: [
          Text(
            context.t.tags,
            style: context.textTheme.labelLarge?.copyWith(color: context.colorScheme.onSurfaceSecondary),
          ),
          Wrap(
            spacing: 8,
            runSpacing: 4,
            children: [
              for (final tag in tags)
                InputChip(
                  key: Key('asset-tag-${tag.id}'),
                  label: Text(tag.value),
                  onDeleted: () => unawaited(remove(tag)),
                  deleteButtonTooltipMessage: context.t.remove_tag,
                ),
              ActionChip(
                key: const Key('asset-tag-add'),
                avatar: const Icon(Icons.add, size: 18),
                label: Text(context.t.add_tag),
                onPressed: () => unawaited(showTagAssetsSheet(context, [remote.id])),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
