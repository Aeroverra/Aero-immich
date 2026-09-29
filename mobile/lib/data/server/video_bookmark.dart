import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/api_repository.dart';
import 'package:immich_mobile/domain/models/video_bookmark.model.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:openapi/api.dart';

final videoBookmarkApiRepositoryProvider = Provider(
  (ref) => VideoBookmarkApiRepository(ref.watch(apiServiceProvider).videoBookmarksApi),
);

class VideoBookmarkApiRepository extends ApiRepository {
  final VideoBookmarksApi _api;

  const VideoBookmarkApiRepository(this._api);

  Future<List<VideoBookmark>> getAll(String assetId) async {
    final response = await _api.getVideoBookmarks(assetId) ?? const <VideoBookmarkResponseDto>[];
    return response.map(_toBookmark).toList()..sort((a, b) => a.time.compareTo(b.time));
  }

  Future<VideoBookmark> create(String assetId, int time) async {
    final response = await checkNull(
      _api.createVideoBookmark(VideoBookmarkCreateDto(assetId: assetId, time: time < 0 ? 0 : time)),
    );
    return _toBookmark(response);
  }

  Future<VideoBookmark> rename(String id, String label) async {
    final response = await checkNull(
      _api.updateVideoBookmark(id, VideoBookmarkUpdateDto(label: Optional.present(label))),
    );
    return _toBookmark(response);
  }

  Future<void> delete(String id) => _api.deleteVideoBookmark(id);

  static VideoBookmark _toBookmark(VideoBookmarkResponseDto dto) =>
      VideoBookmark(id: dto.id, assetId: dto.assetId, time: dto.time, label: dto.label);
}
