import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/presentation/widgets/people/tag_people_sheet.widget.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/infrastructure/people.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/utils/error_handler.dart';
import 'package:immich_mobile/utils/stack_selection.dart';

// videos have no face boxes to draw, so people are tagged on them from the selection
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

class TagPeopleAction extends AssetActionBuilder {
  const TagPeopleAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    final assets = ref.watch(_stateProvider(source));
    if (assets == null) {
      return null;
    }

    return .new(
      icon: Icons.person_add_alt_outlined,
      label: context.t.tag_people_in_videos,
      onAction: () => _tagPeople(context, ref, assets),
    );
  }

  Future<void> _tagPeople(BuildContext context, WidgetRef ref, List<RemoteAsset> assets) async {
    final clearSelection = ref.read(clearSelectionProvider(source));

    try {
      final stacked = await resolveStackedAssets(context, ref, source, assets);
      if (stacked == null || !context.mounted) {
        return;
      }

      final assetIds = [...assets.map((asset) => asset.id), ...stacked.map((asset) => asset.id)];
      final people = await showTagPeopleSheet(context, assetIds.length);
      if (people == null || people.isEmpty || !context.mounted) {
        return;
      }

      if (await tagPeopleOnVideos(context, ref, assetIds, people)) {
        clearSelection();
      }
    } catch (error, stack) {
      handleError(error, stack: stack, description: "Failed to tag people on the videos");
    }
  }
}

/// Tags [people] on the videos among [assetIds] and says what happened. Returns whether any video got a person.
@visibleForTesting
Future<bool> tagPeopleOnVideos(BuildContext context, WidgetRef ref, List<String> assetIds, Set<Person> people) async {
  final result = await ref.read(peopleServiceProvider).tagOnVideos(people.map((person) => person.id), assetIds);
  final toastService = ref.read(toastServiceProvider);
  if (!context.mounted) {
    return result.tagged.isNotEmpty;
  }

  if (result.tagged.isEmpty) {
    toastService.info(context.t.tag_people_nothing_to_tag);
  } else {
    final names = people.map((person) => person.name.isEmpty ? context.t.no_name : person.name).join(', ');
    toastService.success(context.t.tagged_people_in_videos(people: names, count: result.tagged.length));
    // the new faces reach the details sheet and the people pages with the next sync
    unawaited(ref.read(backgroundSyncProvider).syncRemote());
  }
  if (result.photos.isNotEmpty) {
    toastService.info(context.t.tag_people_photos_skipped(count: result.photos.length));
  }

  return result.tagged.isNotEmpty;
}
