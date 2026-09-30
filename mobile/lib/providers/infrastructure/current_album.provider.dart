import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';

final currentRemoteAlbumScopedProvider = Provider<RemoteAlbum?>((ref) => null);
final currentRemoteAlbumProvider = NotifierProvider<CurrentAlbumNotifier, RemoteAlbum?>(
  CurrentAlbumNotifier.new,
  dependencies: [currentRemoteAlbumScopedProvider, remoteAlbumServiceProvider],
);

class CurrentAlbumNotifier extends Notifier<RemoteAlbum?> {
  @override
  RemoteAlbum? build() {
    final album = ref.watch(currentRemoteAlbumScopedProvider);

    if (album == null) {
      return null;
    }

    final watcher = ref
        .watch(remoteAlbumServiceProvider)
        .watchAlbum(album.id, privateFilter: ref.watch(privateModeFilterProvider))
        .listen((updatedAlbum) {
          if (updatedAlbum != null) {
            state = updatedAlbum;
          }
        });

    ref.onDispose(watcher.cancel);

    return album;
  }
}
