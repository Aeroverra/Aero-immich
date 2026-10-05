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

/// The preferences synced from the server, defaults until the first sync arrives
final syncedPreferencesProvider = StreamProvider<Preferences>((ref) {
  final userId = ref.watch(currentUserProvider.select((user) => user?.id));
  if (userId == null) {
    return Stream.value(const Preferences());
  }

  return ref
      .watch(driftProvider)
      .userMetadataRepository
      .watchPreferences(userId)
      .map((preferences) => preferences ?? const Preferences())
      .distinct();
});

/// When the app locks private mode again, "lock when leaving the app" until the preference is known
final privateModeLockTriggerProvider = Provider<LockTrigger>(
  (ref) => ref.watch(
    syncedPreferencesProvider.select((value) => value.valueOrNull?.privateModeLockTrigger ?? LockTrigger.appPause),
  ),
);

/// When the app returns to the default view again, "lock when the screen turns off" until the preference is known
final customViewLockTriggerProvider = Provider<LockTrigger>(
  (ref) => ref.watch(
    syncedPreferencesProvider.select((value) => value.valueOrNull?.customViewLockTrigger ?? LockTrigger.screenOff),
  ),
);

/// The synced privateMode.timeoutMinutes, the fallback the app times a backgrounded session out with
final privateModeTimeoutMinutesProvider = Provider<int>(
  (ref) => ref.watch(syncedPreferencesProvider.select((value) => value.valueOrNull?.privateModeTimeoutMinutes ?? 30)),
);

/// Saves privateMode.lockTrigger on the server, then locally so the app locks the new way before the next sync
final updatePrivateModeLockTriggerProvider = Provider<Future<void> Function(LockTrigger trigger)>(
  (ref) => (trigger) async {
    await ref.read(userApiRepositoryProvider).updatePrivateModeLockTrigger(trigger);
    final userId = ref.read(currentUserProvider)?.id;
    if (userId != null) {
      await ref.read(driftProvider).userMetadataRepository.setPrivateModeLockTrigger(userId, trigger);
    }
  },
);

/// Saves customViews.lockTrigger on the server, then locally so the app resets the view the new way before the next sync
final updateCustomViewLockTriggerProvider = Provider<Future<void> Function(LockTrigger trigger)>(
  (ref) => (trigger) async {
    await ref.read(userApiRepositoryProvider).updateCustomViewLockTrigger(trigger);
    final userId = ref.read(currentUserProvider)?.id;
    if (userId != null) {
      await ref.read(driftProvider).userMetadataRepository.setCustomViewLockTrigger(userId, trigger);
    }
  },
);

final userMetadataPreferencesProvider = FutureProvider<Preferences?>((ref) async {
  final metadataList = await ref.watch(userMetadataProvider.future);
  return metadataList.firstWhereOrNull((meta) => meta.preferences != null)?.preferences;
});
