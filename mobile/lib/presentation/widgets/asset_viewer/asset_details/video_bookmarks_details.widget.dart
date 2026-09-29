import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/events.model.dart';
import 'package:immich_mobile/domain/models/video_bookmark.model.dart';
import 'package:immich_mobile/domain/utils/event_stream.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/duration_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/asset_viewer/video_player_provider.dart';
import 'package:immich_mobile/providers/cast.provider.dart';
import 'package:immich_mobile/providers/infrastructure/video_bookmark.provider.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';

enum _BookmarkAction { rename, delete }

/// The current user's bookmarks on a remote video: tap one to watch from there.
class VideoBookmarksDetails extends ConsumerWidget {
  final BaseAsset asset;

  const VideoBookmarksDetails({super.key, required this.asset});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final remoteId = asset.remoteId;
    if (!asset.isVideo || remoteId == null) {
      return const SizedBox.shrink();
    }

    final bookmarks = ref.watch(videoBookmarksProvider(remoteId)).valueOrNull;
    if (bookmarks == null) {
      return const SizedBox.shrink();
    }
    final notifier = ref.read(videoBookmarksProvider(remoteId).notifier);

    // The video viewer registers its player under the id of the displayed asset.
    void playFrom(VideoBookmark bookmark) {
      final player = ref.read(videoPlayerProvider(asset.id).notifier);
      // Opening the sheet held playback; the jump decides what happens next, so closing the sheet must not resume.
      player.discardHold();

      if (ref.read(castProvider).isCasting) {
        final cast = ref.read(castProvider.notifier);
        cast.seekTo(bookmark.position);
        cast.play();
      } else {
        player.seekTo(bookmark.position);
        // Playing flushes the pending seek to the native player right away.
        unawaited(player.play());
      }

      EventStream.shared.emit(const ViewerHideDetailsEvent());
    }

    Future<void> rename(VideoBookmark bookmark) async {
      final label = await showDialog<String>(
        context: context,
        useRootNavigator: false,
        builder: (_) => _RenameBookmarkDialog(bookmark: bookmark),
      );
      if (label == null) {
        return;
      }

      final saved = await notifier.rename(bookmark.id, label);
      if (!saved && context.mounted) {
        ImmichToast.show(
          context: context,
          msg: context.t.errors.unable_to_update_video_bookmark,
          toastType: ToastType.error,
        );
      }
    }

    Future<void> delete(VideoBookmark bookmark) async {
      final deleted = await notifier.remove(bookmark.id);
      if (!deleted && context.mounted) {
        ImmichToast.show(
          context: context,
          msg: context.t.errors.unable_to_delete_video_bookmark,
          toastType: ToastType.error,
        );
      }
    }

    Future<void> add() async {
      final position = ref.read(videoPlayerProvider(asset.id)).position;
      final bookmark = await notifier.add(position);
      if (!context.mounted) {
        return;
      }
      if (bookmark == null) {
        ImmichToast.show(
          context: context,
          msg: context.t.errors.unable_to_add_video_bookmark,
          toastType: ToastType.error,
        );
        return;
      }
      await rename(bookmark);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 16, right: 4, top: 8),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  context.t.video_bookmarks,
                  style: context.textTheme.labelLarge?.copyWith(color: context.colorScheme.onSurfaceSecondary),
                ),
              ),
              IconButton(
                tooltip: context.t.add_video_bookmark,
                icon: Icon(Icons.bookmark_add_outlined, color: context.colorScheme.onSurfaceSecondary),
                onPressed: add,
              ),
            ],
          ),
        ),
        if (bookmarks.isEmpty)
          Padding(
            padding: const EdgeInsets.only(left: 16, right: 16, bottom: 8),
            child: Text(
              context.t.no_video_bookmarks,
              style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceSecondary),
            ),
          )
        else
          for (final bookmark in bookmarks)
            _BookmarkTile(
              key: ValueKey(bookmark.id),
              bookmark: bookmark,
              onTap: () => playFrom(bookmark),
              onAction: (action) => switch (action) {
                _BookmarkAction.rename => rename(bookmark),
                _BookmarkAction.delete => delete(bookmark),
              },
            ),
      ],
    );
  }
}

class _BookmarkTile extends StatelessWidget {
  final VideoBookmark bookmark;
  final VoidCallback onTap;
  final ValueChanged<_BookmarkAction> onAction;

  const _BookmarkTile({super.key, required this.bookmark, required this.onTap, required this.onAction});

  @override
  Widget build(BuildContext context) {
    final time = bookmark.position.format();
    final hasLabel = bookmark.label.isNotEmpty;
    final label = hasLabel ? bookmark.label : context.t.video_bookmark_untitled;
    return Row(
      children: [
        Expanded(
          child: Semantics(
            button: true,
            label: '${context.t.jump_to_time(time: time)}: $label',
            excludeSemantics: true,
            child: InkWell(
              onTap: onTap,
              child: Padding(
                padding: const EdgeInsets.only(left: 16, top: 12, bottom: 12),
                child: Row(
                  children: [
                    DecoratedBox(
                      decoration: ShapeDecoration(
                        color: context.primaryColor.withAlpha(30),
                        shape: const StadiumBorder(),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        child: Text(
                          time,
                          style: context.textTheme.labelMedium?.copyWith(
                            color: context.primaryColor,
                            fontFeatures: const [FontFeature.tabularFigures()],
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.textTheme.bodyLarge?.copyWith(
                          color: hasLabel ? null : context.colorScheme.onSurfaceSecondary,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        PopupMenuButton<_BookmarkAction>(
          icon: Icon(Icons.more_vert, color: context.colorScheme.onSurfaceSecondary),
          onSelected: onAction,
          itemBuilder: (context) => [
            PopupMenuItem(value: _BookmarkAction.rename, child: Text(context.t.rename_video_bookmark)),
            PopupMenuItem(value: _BookmarkAction.delete, child: Text(context.t.delete_video_bookmark)),
          ],
        ),
      ],
    );
  }
}

class _RenameBookmarkDialog extends StatefulWidget {
  final VideoBookmark bookmark;

  const _RenameBookmarkDialog({required this.bookmark});

  @override
  State<_RenameBookmarkDialog> createState() => _RenameBookmarkDialogState();
}

class _RenameBookmarkDialogState extends State<_RenameBookmarkDialog> {
  late final TextEditingController _controller = TextEditingController(text: widget.bookmark.label);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _save() => Navigator.of(context).pop(_controller.text);

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(context.t.rename_video_bookmark),
      content: TextField(
        controller: _controller,
        autofocus: true,
        maxLength: 200,
        textCapitalization: TextCapitalization.sentences,
        decoration: InputDecoration(
          hintText: context.t.video_bookmark_label_placeholder,
          helperText: widget.bookmark.position.format(),
          border: const OutlineInputBorder(),
        ),
        onSubmitted: (_) => _save(),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(context.t.cancel)),
        TextButton(onPressed: _save, child: Text(context.t.save)),
      ],
    );
  }
}
