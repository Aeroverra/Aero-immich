import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/events.model.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/domain/utils/event_stream.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/duration_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:immich_mobile/presentation/widgets/people/person_edit_name_modal.widget.dart';
import 'package:immich_mobile/providers/asset_viewer/video_player_provider.dart';
import 'package:immich_mobile/providers/cast.provider.dart';
import 'package:immich_mobile/providers/infrastructure/people.provider.dart';
import 'package:immich_mobile/providers/routes.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/utils/image_url_builder.dart';
import 'package:immich_mobile/utils/people.utils.dart';

class PeopleDetails extends ConsumerWidget {
  final BaseAsset asset;

  const PeopleDetails({super.key, required this.asset});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final asset = this.asset;
    if (asset is! RemoteAsset) {
      return const SizedBox.shrink();
    }

    final peopleFuture = ref.watch(peopleAssetProvider(asset.id));
    final faceTimestamps = asset.isVideo
        ? ref.watch(videoFaceTimestampsProvider(asset.id)).valueOrNull ?? const <String, List<int>>{}
        : const <String, List<int>>{};

    // The video viewer registers its player under the id of the displayed asset, which is this one.
    void jumpTo(int timestamp) {
      final position = Duration(milliseconds: timestamp);
      final player = ref.read(videoPlayerProvider(asset.id).notifier);
      // Opening the sheet held playback; closing it must not resume, the video stays paused at the moment.
      player.discardHold();

      if (ref.read(castProvider).isCasting) {
        final cast = ref.read(castProvider.notifier);
        cast.seekTo(position);
        cast.pause();
      } else {
        player.seekTo(position);
        // Pausing flushes the pending seek to the native player right away.
        unawaited(player.pause());
      }

      EventStream.shared.emit(const ViewerHideDetailsEvent());
    }

    Future<void> showNameEditModal(Person person) async {
      await showDialog(
        context: context,
        useRootNavigator: false,
        builder: (BuildContext context) {
          return PersonNameEditForm(person: person);
        },
      );

      ref.invalidate(peopleAssetProvider(asset.id));
    }

    return peopleFuture.when(
      data: (people) {
        return AnimatedCrossFade(
          firstChild: const SizedBox.shrink(),
          secondChild: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(left: 16, top: 16, bottom: 16),
                child: Text(
                  context.t.people,
                  style: context.textTheme.labelLarge?.copyWith(color: context.colorScheme.onSurfaceSecondary),
                ),
              ),
              ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 160),
                child: SingleChildScrollView(
                  padding: const EdgeInsets.only(left: 16.0),
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final person in people)
                        _Avatar(
                          person: person,
                          assetFileCreatedAt: asset.createdAt,
                          timestamps: faceTimestamps[person.id] ?? const [],
                          onTimestampTap: jumpTo,
                          onTap: () {
                            final previousRouteData = ref.read(previousRouteDataProvider);
                            final previousRouteArgs = previousRouteData?.arguments;

                            // Prevent circular navigation
                            if (previousRouteArgs is PersonRouteArgs && previousRouteArgs.person.id == person.id) {
                              context.back();
                              return;
                            }
                            ContextHelper(context).pop();
                            unawaited(context.pushRoute(PersonRoute(person: person)));
                          },
                          onNameTap: () => showNameEditModal(person),
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
          crossFadeState: people.isEmpty ? CrossFadeState.showFirst : CrossFadeState.showSecond,
          duration: Durations.short4,
        );
      },
      error: (error, stack) => Text(context.t.errors.failed_to_load_people, style: context.textTheme.bodyMedium),
      loading: () => const SizedBox.shrink(),
    );
  }
}

class _Avatar extends StatelessWidget {
  final Person person;
  final DateTime assetFileCreatedAt;
  final VoidCallback? onTap;
  final VoidCallback? onNameTap;
  final List<int> timestamps;
  final ValueChanged<int>? onTimestampTap;
  final double imageSize = 96;

  static const _maxTimestamps = 3;

  const _Avatar({
    required this.person,
    required this.assetFileCreatedAt,
    this.onTap,
    this.onNameTap,
    this.timestamps = const [],
    this.onTimestampTap,
  });

  @override
  Widget build(BuildContext context) {
    final birthDate = person.birthDate;
    final formattedAge = birthDate != null ? formatAge(birthDate, assetFileCreatedAt) : null;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 96),
      child: Padding(
        padding: const EdgeInsets.only(right: 16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            GestureDetector(
              onTap: onTap,
              child: SizedBox(
                height: imageSize,
                child: Material(
                  shape: CircleBorder(side: BorderSide(color: context.primaryColor.withAlpha(50), width: 1.0)),
                  shadowColor: context.colorScheme.shadow,
                  elevation: 3,
                  child: CircleAvatar(
                    maxRadius: imageSize / 2,
                    backgroundImage: RemoteImageProvider(
                      url: getFaceThumbnailUrl(person.id, updatedAt: person.updatedAt),
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 4),
            if (person.name.isEmpty)
              GestureDetector(
                onTap: () => onNameTap?.call(),
                child: Text(
                  context.t.add_a_name,
                  style: context.textTheme.labelLarge?.copyWith(color: context.primaryColor),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                ),
              )
            else
              Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    person.name,
                    textAlign: TextAlign.center,
                    overflow: TextOverflow.ellipsis,
                    style: context.textTheme.labelLarge,
                    maxLines: 1,
                  ),
                  if (formattedAge != null)
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(
                        formattedAge,
                        textAlign: TextAlign.center,
                        style: context.textTheme.bodyMedium?.copyWith(
                          color: context.textTheme.bodyMedium?.color?.withAlpha(175),
                        ),
                      ),
                    ),
                ],
              ),
            if (timestamps.isNotEmpty) ...[
              const SizedBox(height: 4),
              Column(
                mainAxisSize: MainAxisSize.min,
                spacing: 4,
                children: [
                  for (final timestamp in timestamps.take(_maxTimestamps))
                    _TimestampChip(timestamp: timestamp, onTap: () => onTimestampTap?.call(timestamp)),
                  if (timestamps.length > _maxTimestamps)
                    Text(
                      '+${timestamps.length - _maxTimestamps}',
                      style: context.textTheme.labelSmall?.copyWith(color: context.colorScheme.onSurfaceSecondary),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _TimestampChip extends StatelessWidget {
  final int timestamp;
  final VoidCallback onTap;

  const _TimestampChip({required this.timestamp, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final label = Duration(milliseconds: timestamp).format();
    return Semantics(
      button: true,
      label: context.t.jump_to_time(time: label),
      excludeSemantics: true,
      child: Material(
        color: context.primaryColor.withAlpha(30),
        shape: const StadiumBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            child: Text(
              label,
              style: context.textTheme.labelSmall?.copyWith(
                color: context.primaryColor,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
