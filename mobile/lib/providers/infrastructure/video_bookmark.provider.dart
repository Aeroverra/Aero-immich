import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/video_bookmark.dart';
import 'package:immich_mobile/domain/models/video_bookmark.model.dart';
import 'package:logging/logging.dart';

/// The current user's bookmarks on a remote video, in time order, keyed by the remote asset id.
///
/// Loading failures (offline, a server without bookmarks) yield an empty list so the viewer never breaks.
final videoBookmarksProvider = AsyncNotifierProvider.autoDispose
    .family<VideoBookmarksNotifier, List<VideoBookmark>, String>(VideoBookmarksNotifier.new);

class VideoBookmarksNotifier extends AutoDisposeFamilyAsyncNotifier<List<VideoBookmark>, String> {
  static final _log = Logger('VideoBookmarksNotifier');

  VideoBookmarkApiRepository get _repository => ref.read(videoBookmarkApiRepositoryProvider);

  @override
  Future<List<VideoBookmark>> build(String assetId) async {
    try {
      return await ref.watch(videoBookmarkApiRepositoryProvider).getAll(assetId);
    } catch (error, stack) {
      _log.warning('Failed to load video bookmarks for $assetId', error, stack);
      return const [];
    }
  }

  List<VideoBookmark> get _current => state.valueOrNull ?? const [];

  /// Bookmarks [position] (rounded to whole milliseconds). Returns null when the server refused it.
  Future<VideoBookmark?> add(Duration position) async {
    try {
      final bookmark = await _repository.create(arg, position.inMilliseconds);
      state = AsyncData([..._current, bookmark]..sort((a, b) => a.time.compareTo(b.time)));
      return bookmark;
    } catch (error, stack) {
      _log.warning('Failed to add a video bookmark to $arg', error, stack);
      return null;
    }
  }

  /// Changes the position and/or the name (trimmed); sends only what changed.
  Future<bool> edit(String id, {int? time, String? label}) async {
    final current = _current.where((bookmark) => bookmark.id == id).firstOrNull;
    if (current == null) {
      return true;
    }
    final nextTime = time == null || time == current.time ? null : (time < 0 ? 0 : time);
    final trimmed = label?.trim();
    final nextLabel = trimmed == null || trimmed == current.label ? null : trimmed;
    if (nextTime == null && nextLabel == null) {
      return true;
    }

    try {
      final bookmark = await _repository.update(id, time: nextTime, label: nextLabel);
      state = AsyncData(
        [for (final item in _current) item.id == id ? bookmark : item]..sort((a, b) => a.time.compareTo(b.time)),
      );
      return true;
    } catch (error, stack) {
      _log.warning('Failed to edit video bookmark $id', error, stack);
      return false;
    }
  }

  Future<bool> remove(String id) async {
    try {
      await _repository.delete(id);
      state = AsyncData([
        for (final item in _current)
          if (item.id != id) item,
      ]);
      return true;
    } catch (error, stack) {
      _log.warning('Failed to delete video bookmark $id', error, stack);
      return false;
    }
  }
}
