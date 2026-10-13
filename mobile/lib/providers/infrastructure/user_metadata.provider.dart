import 'package:collection/collection.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';

final userMetadataProvider = FutureProvider<List<UserMetadata>>((ref) async {
  final repository = ref.watch(driftProvider).userMetadataRepository;
  final user = ref.watch(currentUserProvider);
  if (user == null) {
    return [];
  }
  return repository.getUserMetadata(user.id);
});

/// Whether automatic stacks are shown grouped (server-side stacks.groupAuto), following syncs as they arrive
final groupAutoStacksStreamProvider = StreamProvider<bool>((ref) {
  final userId = ref.watch(currentUserProvider.select((user) => user?.id));
  if (userId == null) {
    return Stream.value(true);
  }

  return ref
      .watch(driftProvider)
      .userMetadataRepository
      .watchPreferences(userId)
      .map((preferences) => preferences?.groupAutoStacks ?? true)
      .distinct();
});

/// Grouped until the preference is known
final groupAutoStacksProvider = Provider<bool>(
  (ref) => ref.watch(groupAutoStacksStreamProvider.select((value) => value.valueOrNull ?? true)),
);

/// Saves stacks.groupAuto on the server, then in the local preferences so the timeline follows before the next sync
final updateGroupAutoStacksProvider = Provider<Future<void> Function(bool groupAuto)>(
  (ref) => (groupAuto) async {
    await ref.read(userApiRepositoryProvider).updateGroupAutoStacks(groupAuto);
    final userId = ref.read(currentUserProvider)?.id;
    if (userId != null) {
      await ref.read(driftProvider).userMetadataRepository.setGroupAutoStacks(userId, groupAuto);
    }
  },
);

final userMetadataPreferencesProvider = FutureProvider<Preferences?>((ref) async {
  final metadataList = await ref.watch(userMetadataProvider.future);
  return metadataList.firstWhereOrNull((meta) => meta.preferences != null)?.preferences;
});
