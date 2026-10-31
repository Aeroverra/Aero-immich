import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/datetime_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/sheet_tile.widget.dart';
import 'package:immich_mobile/providers/infrastructure/asset_metadata.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/utils/asset_metadata.utils.dart';
import 'package:url_launcher/url_launcher.dart';

const _kSeparator = '  •  ';

class CustomFieldsDetails extends ConsumerWidget {
  final BaseAsset asset;

  const CustomFieldsDetails({super.key, required this.asset});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final asset = this.asset;
    if (asset is! RemoteAsset || asset.ownerId != ref.watch(currentUserProvider)?.id) {
      return const SizedBox.shrink();
    }

    final entries = ref.watch(assetMetadataProvider(asset.id)).valueOrNull ?? const [];
    final groups = getAssetMetadataGroups(entries, (text, [args]) => _translate(context, text, args), (dateTime) {
      final alwaysUse24HourFormat = MediaQuery.alwaysUse24HourFormatOf(context);
      final date = DateFormat.yMMMEd(resolvedDateTimeLocale()).format(dateTime);
      return '$date$_kSeparator${dateTime.formatTime(alwaysUse24HourFormat: alwaysUse24HourFormat)}';
    });
    if (groups.isEmpty) {
      return const SizedBox.shrink();
    }

    return _CustomFieldsSection(groups: groups, googlePhotosUrl: getGooglePhotosUrl(entries), entries: entries);
  }

  static String _translate(BuildContext context, AssetMetadataText text, Map<String, Object>? args) {
    final t = context.t;
    return switch (text) {
      .taken => t.asset_metadata_taken,
      .uploaded => t.asset_metadata_uploaded,
      .views => t.asset_metadata_views,
      .origin => t.asset_metadata_origin,
      .originMobileUpload => t.asset_metadata_origin_mobile_upload,
      .originWebUpload => t.asset_metadata_origin_web_upload,
      .originSharedAlbum => t.asset_metadata_origin_shared_album,
      .device => t.asset_metadata_device,
      .deviceAndroidPhone => t.asset_metadata_device_android_phone,
      .deviceAndroidTablet => t.asset_metadata_device_android_tablet,
      .deviceIosPhone => t.asset_metadata_device_ios_phone,
      .app => t.asset_metadata_app,
      .deviceFolder => t.asset_metadata_device_folder,
      .altitude => t.asset_metadata_altitude,
      .altitudeValue => t.asset_metadata_altitude_value(altitude: args?['altitude'] ?? ''),
      .people => t.asset_metadata_people,
      .peopleRemoved => t.asset_metadata_people_removed,
      .removedNotInPhoto => t.asset_metadata_removed_not_in_photo,
      .removedOffTopic => t.asset_metadata_removed_off_topic,
      .removedNonHuman => t.asset_metadata_removed_non_human,
      .addedByOtherUser => t.asset_metadata_added_by_other_user,
      .yes => t.asset_metadata_yes,
      .comments => t.asset_metadata_comments,
      .commentLiked => t.asset_metadata_comment_liked(author: args?['author'] ?? ''),
    };
  }
}

class _CustomFieldsSection extends HookConsumerWidget {
  final List<AssetMetadataGroup> groups;
  final String? googlePhotosUrl;
  final List<AssetMetadataEntry> entries;

  const _CustomFieldsSection({required this.groups, required this.googlePhotosUrl, required this.entries});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final expanded = ref.watch(assetMetadataExpandedProvider);
    final showRaw = useState(false);
    final labelStyle = context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceSecondary);
    final googlePhotosUrl = this.googlePhotosUrl;

    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SheetTile(
            title: context.t.asset_metadata,
            titleStyle: context.textTheme.labelLarge?.copyWith(color: context.colorScheme.onSurfaceSecondary),
            trailing: Icon(
              expanded ? Icons.expand_less : Icons.expand_more,
              color: context.colorScheme.onSurfaceSecondary,
            ),
            onTap: () => ref.read(assetMetadataExpandedProvider.notifier).state = !expanded,
          ),
          if (expanded) ...[
            for (final group in groups) ...[
              if (!group.isGooglePhotos)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                  child: Text(group.key, style: context.textTheme.labelMedium),
                ),
              for (final row in group.rows)
                SheetTile(
                  title: row.value,
                  titleStyle: context.textTheme.bodyMedium,
                  subtitle: row.label,
                  subtitleStyle: labelStyle,
                ),
            ],
            if (googlePhotosUrl != null)
              SheetTile(
                title: context.t.open_in_google_photos,
                titleStyle: context.textTheme.bodyMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                  color: context.primaryColor,
                ),
                leading: Icon(Icons.open_in_new, color: context.primaryColor),
                onTap: () => unawaited(launchUrl(Uri.parse(googlePhotosUrl), mode: LaunchMode.externalApplication)),
              ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: TextButton(
                onPressed: () => showRaw.value = !showRaw.value,
                child: Text(showRaw.value ? context.t.asset_metadata_hide_raw : context.t.asset_metadata_show_raw),
              ),
            ),
            if (showRaw.value)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.symmetric(horizontal: 16),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: context.colorScheme.surfaceContainerHigh,
                  borderRadius: const BorderRadius.all(Radius.circular(12)),
                ),
                child: SelectableText(
                  getAssetMetadataJson(entries),
                  style: context.textTheme.bodySmall?.copyWith(fontFamily: 'monospace'),
                ),
              ),
          ],
        ],
      ),
    );
  }
}
