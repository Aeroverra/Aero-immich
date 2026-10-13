import 'dart:async';
import 'dart:math';

import 'package:async/async.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/colors.dart';
import 'package:immich_mobile/domain/models/video_bookmark.model.dart';
import 'package:immich_mobile/extensions/duration_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/models/cast/cast_manager_state.dart';
import 'package:immich_mobile/providers/asset_viewer/asset_viewer.provider.dart';
import 'package:immich_mobile/providers/asset_viewer/video_player_provider.dart';
import 'package:immich_mobile/providers/cast.provider.dart';
import 'package:immich_mobile/providers/infrastructure/video_bookmark.provider.dart';
import 'package:immich_mobile/widgets/asset_viewer/animated_play_pause.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';

class VideoControls extends ConsumerStatefulWidget {
  final String videoPlayerName;

  /// Remote id of the video, to show and add bookmarks. Null for videos that are only on this device.
  final String? bookmarkAssetId;

  /// Where smart search matched in the video, when it was opened from the search results and matched on a frame
  final Duration? searchMatch;

  static const List<Shadow> _controlShadows = [Shadow(color: Colors.black87, blurRadius: 6, offset: Offset(0, 1))];

  const VideoControls({super.key, required this.videoPlayerName, this.bookmarkAssetId, this.searchMatch});

  @override
  ConsumerState<VideoControls> createState() => _VideoControlsState();
}

class _VideoControlsState extends ConsumerState<VideoControls> {
  late final RestartableTimer _hideTimer;

  AutoDisposeStateNotifierProvider<VideoPlayerNotifier, VideoPlayerState> get _provider =>
      videoPlayerProvider(widget.videoPlayerName);

  @override
  void initState() {
    super.initState();
    _hideTimer = RestartableTimer(const Duration(seconds: 5), _onHideTimer);
  }

  @override
  void didUpdateWidget(covariant VideoControls oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.videoPlayerName != widget.videoPlayerName) {
      _hideTimer.reset();
    }
  }

  @override
  void dispose() {
    _hideTimer.cancel();
    super.dispose();
  }

  void _onHideTimer() {
    if (!mounted) {
      return;
    }
    if (ref.read(_provider).status == VideoPlaybackStatus.playing) {
      ref.read(assetViewerProvider.notifier).setControls(false);
    }
  }

  void _toggle(bool isCasting) {
    if (isCasting) {
      ref.read(castProvider.notifier).toggle();
      return;
    }

    ref.read(_provider.notifier).toggle();
  }

  void _onSeek(bool isCasting, double value) {
    final seekTo = Duration(microseconds: value.toInt());

    if (isCasting) {
      ref.read(castProvider.notifier).seekTo(seekTo);
      return;
    }

    ref.read(_provider.notifier).seekTo(seekTo);
  }

  /// Pauses the video on the moment that matched the search, so the match can be checked
  void _jumpToSearchMatch(bool isCasting, Duration position) {
    _hideTimer.reset();
    if (isCasting) {
      final cast = ref.read(castProvider.notifier);
      cast.seekTo(position);
      cast.pause();
      return;
    }

    final player = ref.read(_provider.notifier);
    player.discardHold();
    player.seekTo(position);
    // pausing flushes the pending seek to the native player right away
    unawaited(player.pause());
  }

  Future<void> _addBookmark(String assetId, Duration position) async {
    _hideTimer.reset();
    final bookmark = await ref.read(videoBookmarksProvider(assetId).notifier).add(position);
    if (!mounted) {
      return;
    }

    ImmichToast.show(
      context: context,
      msg: bookmark == null
          ? context.t.errors.unable_to_add_video_bookmark
          : context.t.video_bookmark_added(time: bookmark.position.format()),
      toastType: bookmark == null ? ToastType.error : ToastType.success,
    );
  }

  @override
  Widget build(BuildContext context) {
    final cast = ref.watch(castProvider);
    final isCasting = cast.isCasting;

    final (position, duration) = isCasting
        ? ref.watch(castProvider.select((c) => (c.currentTime, c.duration)))
        : ref.watch(_provider.select((v) => (v.position, v.duration)));

    final videoStatus = ref.watch(_provider.select((v) => v.status));
    final (source, resolution) = ref.watch(_provider.select((v) => (v.source, v.resolution)));
    final isPlaying = isCasting
        ? cast.castState == CastState.playing
        : videoStatus == VideoPlaybackStatus.playing || videoStatus == VideoPlaybackStatus.buffering;
    final isFinished = !isCasting && videoStatus == VideoPlaybackStatus.completed;

    ref.listen(assetViewerProvider.select((v) => v.showingControls), (prev, showing) {
      if (showing && prev != showing) {
        _hideTimer.reset();
      }
    });
    ref.listen(_provider.select((v) => v.status), (_, _) => _hideTimer.reset());

    final notifier = ref.watch(_provider.notifier);
    final isLoaded = duration != Duration.zero;
    final bookmarkAssetId = widget.bookmarkAssetId;
    final bookmarks = bookmarkAssetId == null
        ? const <VideoBookmark>[]
        : ref.watch(videoBookmarksProvider(bookmarkAssetId)).valueOrNull ?? const <VideoBookmark>[];
    final searchMatch = widget.searchMatch;

    return Padding(
      padding: const EdgeInsets.only(left: 16, right: 16, bottom: 12),
      child: Column(
        spacing: 4,
        children: [
          if (searchMatch != null)
            Align(
              alignment: Alignment.centerLeft,
              child: Padding(
                padding: const EdgeInsets.only(left: 12),
                child: VideoSearchMatchChip(
                  position: searchMatch,
                  onTap: () => _jumpToSearchMatch(isCasting, searchMatch),
                ),
              ),
            ),
          Row(
            children: [
              IconButton(
                iconSize: 32,
                padding: const EdgeInsets.all(12),
                constraints: const BoxConstraints(),
                icon: isFinished
                    ? const Icon(Icons.replay, color: Colors.white, shadows: VideoControls._controlShadows)
                    : AnimatedPlayPause(
                        color: Colors.white,
                        playing: isPlaying,
                        shadows: VideoControls._controlShadows,
                      ),
                onPressed: () => _toggle(isCasting),
              ),
              if (bookmarkAssetId != null)
                IconButton(
                  iconSize: 26,
                  padding: const EdgeInsets.all(12),
                  constraints: const BoxConstraints(),
                  tooltip: context.t.add_video_bookmark,
                  icon: const Icon(
                    Icons.bookmark_add_outlined,
                    color: Colors.white,
                    shadows: VideoControls._controlShadows,
                  ),
                  onPressed: isLoaded ? () => _addBookmark(bookmarkAssetId, position) : null,
                ),
              Expanded(
                child: Align(
                  alignment: Alignment.centerRight,
                  child: source == null || isCasting
                      ? null
                      : Padding(
                          padding: const EdgeInsets.only(left: 8, right: 12),
                          child: VideoPlaybackSourceChip(source: source, resolution: resolution),
                        ),
                ),
              ),
              IgnorePointer(
                child: Text(
                  "${position.format()} / ${duration.format()}",
                  style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.w500,
                    fontFeatures: [FontFeature.tabularFigures()],
                    shadows: VideoControls._controlShadows,
                  ),
                ),
              ),
              const SizedBox(width: 12),
            ],
          ),
          Stack(
            alignment: Alignment.center,
            children: [
              Slider(
                value: min(position.inMicroseconds.toDouble(), duration.inMicroseconds.toDouble()),
                min: 0,
                max: max(duration.inMicroseconds.toDouble(), 1),
                thumbColor: Colors.white,
                activeColor: Colors.white,
                inactiveColor: whiteOpacity75,
                padding: EdgeInsets.zero,
                onChangeStart: (_) => notifier.hold(),
                onChangeEnd: (_) => notifier.release(),
                onChanged: isLoaded ? (value) => _onSeek(isCasting, value) : null,
              ),
              if (isLoaded && bookmarks.isNotEmpty)
                Positioned.fill(
                  child: IgnorePointer(
                    child: VideoBookmarkMarkers(bookmarks: bookmarks, duration: duration),
                  ),
                ),
              if (isLoaded && searchMatch != null)
                Positioned.fill(
                  child: IgnorePointer(
                    child: VideoSearchMatchMarker(position: searchMatch, duration: duration),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Says which file is playing: the transcoded copy, the original or the copy on this device.
class VideoPlaybackSourceChip extends StatelessWidget {
  final VideoPlaybackSource source;
  final int? resolution;

  const VideoPlaybackSourceChip({super.key, required this.source, this.resolution});

  @override
  Widget build(BuildContext context) {
    final (label, description) = switch (source) {
      VideoPlaybackSource.transcoded => (
        context.t.video_source_transcoded,
        context.t.video_source_transcoded_description,
      ),
      VideoPlaybackSource.original => (context.t.video_source_original, context.t.video_source_original_description),
      VideoPlaybackSource.device => (context.t.video_source_on_device, context.t.video_source_on_device_description),
    };

    return Tooltip(
      message: description,
      triggerMode: TooltipTriggerMode.tap,
      child: DecoratedBox(
        decoration: BoxDecoration(color: Colors.black45, borderRadius: BorderRadius.circular(12)),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
          child: Text(
            resolution == null ? label : '$label · ${resolution}p',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w500),
          ),
        ),
      ),
    );
  }
}

/// Says where smart search matched in the video. Tapping it pauses the video on that moment.
class VideoSearchMatchChip extends StatelessWidget {
  final Duration position;
  final VoidCallback onTap;

  const VideoSearchMatchChip({super.key, required this.position, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final label = context.t.video_search_match(time: position.format());
    return Tooltip(
      message: context.t.video_search_match_description,
      child: Semantics(
        button: true,
        label: label,
        excludeSemantics: true,
        child: Material(
          color: Colors.black45,
          borderRadius: BorderRadius.circular(12),
          child: InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                spacing: 4,
                children: [
                  const Icon(Icons.search, size: 14, color: Colors.white),
                  Text(
                    label,
                    style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w500),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A dot over the seek bar at the moment that matched the search, so it reads apart from the yellow bookmark ticks.
class VideoSearchMatchMarker extends StatelessWidget {
  final Duration position;
  final Duration duration;

  static const ringColor = Color(0xFF3B82F6);
  static const _size = 9.0;

  const VideoSearchMatchMarker({super.key, required this.position, required this.duration});

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final share = duration.inMilliseconds == 0
            ? 0.0
            : (position.inMilliseconds / duration.inMilliseconds).clamp(0.0, 1.0);
        return Stack(
          children: [
            Positioned(
              key: const ValueKey('search-match'),
              left: (constraints.maxWidth * share - _size / 2).clamp(0.0, max(0.0, constraints.maxWidth - _size)),
              top: (constraints.maxHeight - _size) / 2,
              child: Container(
                width: _size,
                height: _size,
                decoration: BoxDecoration(
                  color: Colors.white,
                  shape: BoxShape.circle,
                  border: Border.all(color: ringColor, width: 2),
                  boxShadow: const [BoxShadow(color: Colors.black54, blurRadius: 2)],
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

/// Short ticks over the seek bar at the bookmarked moments. The bar has no padding, so the track spans the full width.
class VideoBookmarkMarkers extends StatelessWidget {
  final List<VideoBookmark> bookmarks;
  final Duration duration;

  static const markerColor = Color(0xFFFACC15);
  static const _width = 3.0;
  static const _height = 10.0;

  const VideoBookmarkMarkers({super.key, required this.bookmarks, required this.duration});

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final total = duration.inMilliseconds;
        return Stack(
          children: [
            for (final bookmark in bookmarks)
              Positioned(
                key: ValueKey(bookmark.id),
                left: (constraints.maxWidth * (bookmark.time / total).clamp(0.0, 1.0) - _width / 2).clamp(
                  0.0,
                  max(0.0, constraints.maxWidth - _width),
                ),
                top: (constraints.maxHeight - _height) / 2,
                child: Container(
                  width: _width,
                  height: _height,
                  decoration: BoxDecoration(
                    color: markerColor,
                    borderRadius: BorderRadius.circular(1),
                    boxShadow: const [BoxShadow(color: Colors.black54, blurRadius: 2)],
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}
