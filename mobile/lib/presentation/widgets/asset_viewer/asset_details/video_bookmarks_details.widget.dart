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
import 'package:immich_mobile/utils/video_bookmark_time.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';

enum _BookmarkAction { edit, delete }

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

    Future<void> edit(VideoBookmark bookmark) async {
      final duration = ref.read(videoPlayerProvider(asset.id)).duration;
      final result = await showDialog<({int time, String label})>(
        context: context,
        useRootNavigator: false,
        builder: (_) => EditVideoBookmarkDialog(
          bookmark: bookmark,
          maxTime: duration > Duration.zero ? duration.inMilliseconds : null,
          // shows the moment behind the dialog while it is being adjusted
          onTimeChanged: (time) =>
              ref.read(videoPlayerProvider(asset.id).notifier).seekTo(Duration(milliseconds: time)),
        ),
      );
      if (result == null) {
        return;
      }

      final saved = await notifier.edit(bookmark.id, time: result.time, label: result.label);
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
      await edit(bookmark);
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
                _BookmarkAction.edit => edit(bookmark),
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
            PopupMenuItem(value: _BookmarkAction.edit, child: Text(context.t.edit_video_bookmark)),
            PopupMenuItem(value: _BookmarkAction.delete, child: Text(context.t.delete_video_bookmark)),
          ],
        ),
      ],
    );
  }
}

/// Name and position of a bookmark: - and + move it by a second, or type a time like 1:05.
class EditVideoBookmarkDialog extends StatefulWidget {
  final VideoBookmark bookmark;

  /// Length of the video in milliseconds, when known
  final int? maxTime;
  final ValueChanged<int>? onTimeChanged;

  const EditVideoBookmarkDialog({super.key, required this.bookmark, this.maxTime, this.onTimeChanged});

  @override
  State<EditVideoBookmarkDialog> createState() => _EditVideoBookmarkDialogState();
}

class _EditVideoBookmarkDialogState extends State<EditVideoBookmarkDialog> {
  late final TextEditingController _label = TextEditingController(text: widget.bookmark.label);
  late final TextEditingController _time = TextEditingController(text: formatBookmarkTime(widget.bookmark.time));
  late int _timeMs = widget.bookmark.time;
  bool _invalid = false;

  @override
  void dispose() {
    _label.dispose();
    _time.dispose();
    super.dispose();
  }

  int _clamp(int time) {
    final max = widget.maxTime;
    final atLeastZero = time < 0 ? 0 : time;
    return max != null && atLeastZero > max ? max : atLeastZero;
  }

  void _moveTo(int time) {
    final next = _clamp(time);
    setState(() {
      _timeMs = next;
      _invalid = false;
      _time.text = formatBookmarkTime(next);
    });
    widget.onTimeChanged?.call(next);
  }

  /// Applies the typed time; returns false and flags the field when the text is not a time
  bool _commitTyped() {
    if (_time.text.trim() == formatBookmarkTime(_timeMs)) {
      setState(() => _invalid = false);
      return true;
    }
    final typed = parseBookmarkTime(_time.text);
    if (typed == null) {
      setState(() => _invalid = true);
      return false;
    }
    _moveTo(typed);
    return true;
  }

  void _save() {
    if (_commitTyped()) {
      Navigator.of(context).pop((time: _timeMs, label: _label.text));
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(context.t.edit_video_bookmark),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                IconButton.filledTonal(
                  tooltip: context.t.video_bookmark_earlier,
                  icon: const Icon(Icons.remove),
                  onPressed: () => _moveTo(_timeMs - 1000),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: 112,
                  child: TextField(
                    controller: _time,
                    textAlign: TextAlign.center,
                    keyboardType: TextInputType.datetime,
                    style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()]),
                    decoration: InputDecoration(
                      labelText: context.t.video_bookmark_time,
                      border: const OutlineInputBorder(),
                      errorText: _invalid ? '' : null,
                      isDense: true,
                    ),
                    onSubmitted: (_) => _commitTyped(),
                    onTapOutside: (_) => _commitTyped(),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filledTonal(
                  tooltip: context.t.video_bookmark_later,
                  icon: const Icon(Icons.add),
                  onPressed: () => _moveTo(_timeMs + 1000),
                ),
              ],
            ),
            if (_invalid)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  context.t.video_bookmark_time_hint_mobile,
                  textAlign: TextAlign.center,
                  style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.error),
                ),
              ),
            const SizedBox(height: 16),
            TextField(
              controller: _label,
              maxLength: 200,
              textCapitalization: TextCapitalization.sentences,
              decoration: InputDecoration(
                labelText: context.t.video_bookmark_label,
                hintText: context.t.video_bookmark_label_placeholder,
                border: const OutlineInputBorder(),
              ),
              onSubmitted: (_) => _save(),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(context.t.cancel)),
        TextButton(onPressed: _save, child: Text(context.t.save)),
      ],
    );
  }
}
