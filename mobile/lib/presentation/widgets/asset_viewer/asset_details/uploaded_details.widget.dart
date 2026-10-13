import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/datetime_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/sheet_tile.widget.dart';
import 'package:immich_mobile/providers/asset_viewer/asset_viewer.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset_viewer/asset.provider.dart';

const _kSeparator = '  •  ';

/// When the asset was uploaded: the Google Photos upload time for assets imported from Google Photos, else the Immich
/// upload time. When the asset reached Immich on another day, that day shows below it. Asked from the server once the
/// details are open, so paging through the viewer does not fetch every asset. Hidden for assets only on the device.
class UploadedDetails extends ConsumerWidget {
  final BaseAsset asset;

  const UploadedDetails({super.key, required this.asset});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final remoteId = asset.remoteId;
    final showingDetails = ref.watch(assetViewerProvider.select((state) => state.showingDetails));
    if (remoteId == null || !showingDetails) {
      return const SizedBox.shrink();
    }

    final dates = ref.watch(assetUploadDatesProvider(remoteId)).valueOrNull;
    if (dates == null) {
      return const SizedBox.shrink();
    }

    final locale = resolvedDateTimeLocale();
    final uploadedAt = dates.uploadedAt.toLocal();
    final createdAt = dates.createdAt.toLocal();
    final date = DateFormat.yMMMEd(locale).format(uploadedAt);
    final time = uploadedAt.formatTime(alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context));

    return Column(
      children: [
        const SizedBox(height: 16),
        SheetTile(
          title: '${context.t.uploaded}$_kSeparator$date$_kSeparator$time',
          titleStyle: context.textTheme.labelLarge,
          leading: Icon(Icons.cloud_upload_outlined, size: 24, color: context.textTheme.labelLarge?.color),
          subtitle: DateUtils.isSameDay(uploadedAt, createdAt)
              ? null
              : context.t.added_to_immich_date(date: DateFormat.yMMMd(locale).format(createdAt)),
          subtitleStyle: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceSecondary),
        ),
      ],
    );
  }
}
