import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/presentation/widgets/people/people_assets_sheet.widget.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/utils/error_handler.dart';
import 'package:immich_mobile/utils/stack_selection.dart';

final _stateProvider = Provider.family.autoDispose<List<RemoteAsset>?, ActionSource>((ref, source) {
  final peopleEnabled = ref.watch(
    userMetadataPreferencesProvider.select((value) => value.valueOrNull?.peopleEnabled ?? true),
  );
  if (!peopleEnabled) {
    return null;
  }

  final assets = ref.watch(ownedAssetsActionProvider(source)).toList(growable: false);
  return assets.isEmpty ? null : assets;
}, dependencies: [ownedAssetsActionProvider]);

/// Adds people to or takes them off the selected photos and videos, without a face box
class PeopleAction extends AssetActionBuilder {
  const PeopleAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    final assets = ref.watch(_stateProvider(source));
    if (assets == null) {
      return null;
    }

    return .new(
      icon: Icons.people_alt_outlined,
      label: context.t.people_edit_assets,
      onAction: () => _editPeople(context, ref, assets),
    );
  }

  Future<void> _editPeople(BuildContext context, WidgetRef ref, List<RemoteAsset> assets) async {
    final clearSelection = ref.read(clearSelectionProvider(source));

    try {
      final stacked = await resolveStackedAssets(context, ref, source, assets);
      if (stacked == null || !context.mounted) {
        return;
      }

      final assetIds = [...assets.map((asset) => asset.id), ...stacked.map((asset) => asset.id)];
      final changed = await showPeopleAssetsSheet(context, assetIds);
      if (!changed) {
        return;
      }

      clearSelection();
      // the new and removed faces reach the details sheet and the people pages with the next sync
      unawaited(ref.read(backgroundSyncProvider).syncRemote());
    } catch (error, stack) {
      handleError(error, stack: stack, description: "Failed to change the people of the assets");
    }
  }
}
