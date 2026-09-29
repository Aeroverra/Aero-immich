import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/presentation/widgets/people/add_people_sheet.widget.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/infrastructure/people.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/utils/error_handler.dart';
import 'package:immich_mobile/utils/stack_selection.dart';

// videos have no face boxes to draw, so people are added on them from the selection
final _stateProvider = Provider.family.autoDispose<List<RemoteAsset>?, ActionSource>((ref, source) {
  final peopleEnabled = ref.watch(
    userMetadataPreferencesProvider.select((value) => value.valueOrNull?.peopleEnabled ?? true),
  );
  if (!peopleEnabled) {
    return null;
  }

  final assets = ref.watch(ownedAssetsActionProvider(source)).toList(growable: false);
  return assets.any((asset) => asset.isVideo) ? assets : null;
}, dependencies: [ownedAssetsActionProvider]);

class AddPeopleAction extends AssetActionBuilder {
  const AddPeopleAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    final assets = ref.watch(_stateProvider(source));
    if (assets == null) {
      return null;
    }

    return .new(
      icon: Icons.person_add_alt_outlined,
      label: context.t.add_people_to_videos,
      onAction: () => _addPeople(context, ref, assets),
    );
  }

  Future<void> _addPeople(BuildContext context, WidgetRef ref, List<RemoteAsset> assets) async {
    final clearSelection = ref.read(clearSelectionProvider(source));

    try {
      final stacked = await resolveStackedAssets(context, ref, source, assets);
      if (stacked == null || !context.mounted) {
        return;
      }

      final assetIds = [...assets.map((asset) => asset.id), ...stacked.map((asset) => asset.id)];
      final people = await showAddPeopleSheet(context, assetIds.length);
      if (people == null || people.isEmpty || !context.mounted) {
        return;
      }

      if (await addPeopleToVideos(context, ref, assetIds, people)) {
        clearSelection();
      }
    } catch (error, stack) {
      handleError(error, stack: stack, description: "Failed to add people to the videos");
    }
  }
}

/// Adds [people] to the videos among [assetIds] and says what happened. Returns whether any video got a person.
@visibleForTesting
Future<bool> addPeopleToVideos(BuildContext context, WidgetRef ref, List<String> assetIds, Set<Person> people) async {
  final result = await ref.read(peopleServiceProvider).addToVideos(people.map((person) => person.id), assetIds);
  final toastService = ref.read(toastServiceProvider);
  if (!context.mounted) {
    return result.added.isNotEmpty;
  }

  if (result.added.isEmpty) {
    toastService.info(context.t.add_people_to_videos_none_added);
  } else {
    final names = people.map((person) => person.name.isEmpty ? context.t.no_name : person.name).join(', ');
    toastService.success(context.t.added_people_to_videos(people: names, count: result.added.length));
    // the new faces reach the details sheet and the people pages with the next sync
    unawaited(ref.read(backgroundSyncProvider).syncRemote());
  }
  if (result.photos.isNotEmpty) {
    toastService.info(context.t.add_people_to_videos_photos_skipped(count: result.photos.length));
  }

  return result.added.isNotEmpty;
}
