import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/data/db/main/table/user/metadata.drift.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';

@DriftAccessor()
class UserMetadataRepository extends DatabaseAccessor<Drift> {
  UserMetadataRepository(super.attachedDatabase);

  Drift get _db => attachedDatabase;

  /// The stackActions.mode preference synced from the server, ask until it is known
  Future<StackActionMode> getStackActionMode(String userId) async {
    final metadata = await getUserMetadata(userId);
    for (final item in metadata) {
      if (item.preferences case final preferences?) {
        return preferences.stackActionMode;
      }
    }
    return StackActionMode.ask;
  }

  /// Applies a stackActions.mode change the server accepted, so the choice holds before the next sync
  Future<void> setStackActionMode(String userId, StackActionMode mode) async {
    await _db.transaction(() async {
      final query = _db.userMetadataEntity.select()
        ..where((e) => e.userId.equals(userId) & e.key.equalsValue(UserMetadataKey.preferences));
      final current = await query.getSingleOrNull();
      final value = <String, Object?>{...?current?.value};
      value['stackActions'] = <String, Object?>{
        ...?(value['stackActions'] as Map<String, Object?>?),
        'mode': mode.name,
      };

      await _db
          .into(_db.userMetadataEntity)
          .insertOnConflictUpdate(
            UserMetadataEntityCompanion.insert(userId: userId, key: UserMetadataKey.preferences, value: value),
          );
    });
  }

  /// Applies a privateMode.lockTrigger change the server accepted, so the app locks the new way right away
  Future<void> setPrivateModeLockTrigger(String userId, LockTrigger trigger) =>
      _setPreference(userId, 'privateMode', 'lockTrigger', trigger.name);

  /// Applies a customViews.lockTrigger change the server accepted, so the app resets the view the new way right away
  Future<void> setCustomViewLockTrigger(String userId, LockTrigger trigger) =>
      _setPreference(userId, 'customViews', 'lockTrigger', trigger.name);

  /// Merges [key] into the [group] block of the stored preferences, leaving every other preference alone
  Future<void> _setPreference(String userId, String group, String key, Object? value) async {
    await _db.transaction(() async {
      final query = _db.userMetadataEntity.select()
        ..where((e) => e.userId.equals(userId) & e.key.equalsValue(UserMetadataKey.preferences));
      final current = await query.getSingleOrNull();
      final preferences = <String, Object?>{...?current?.value};
      preferences[group] = <String, Object?>{...?(preferences[group] as Map<String, Object?>?), key: value};

      await _db
          .into(_db.userMetadataEntity)
          .insertOnConflictUpdate(
            UserMetadataEntityCompanion.insert(userId: userId, key: UserMetadataKey.preferences, value: preferences),
          );
    });
  }

  Future<List<UserMetadata>> getUserMetadata(String userId) {
    final query = _db.userMetadataEntity.select()..where((e) => e.userId.equals(userId));

    return query.map((userMetadata) {
      return userMetadata.toDto();
    }).get();
  }

  /// The preferences synced from the server, re-emitted whenever a sync or [setGroupAutoStacks] changes them
  Stream<Preferences?> watchPreferences(String userId) {
    final query = _db.userMetadataEntity.select()
      ..where((e) => e.userId.equals(userId) & e.key.equalsValue(UserMetadataKey.preferences));

    return query.watchSingleOrNull().map((row) => row == null ? null : Preferences.fromMap(row.value));
  }

  /// Applies a stacks.groupAuto change the server accepted, so the timeline follows before the next sync
  Future<void> setGroupAutoStacks(String userId, bool groupAuto) async {
    await _db.transaction(() async {
      final query = _db.userMetadataEntity.select()
        ..where((e) => e.userId.equals(userId) & e.key.equalsValue(UserMetadataKey.preferences));
      final current = await query.getSingleOrNull();
      final value = <String, Object?>{...?current?.value};
      value['stacks'] = <String, Object?>{...?(value['stacks'] as Map<String, Object?>?), 'groupAuto': groupAuto};

      await _db
          .into(_db.userMetadataEntity)
          .insertOnConflictUpdate(
            UserMetadataEntityCompanion.insert(userId: userId, key: UserMetadataKey.preferences, value: value),
          );
    });
  }
}

extension UserMetadataDataExtension on UserMetadataEntityData {
  UserMetadata toDto() => switch (key) {
    UserMetadataKey.onboarding => UserMetadata(userId: userId, key: key, onboarding: Onboarding.fromMap(value)),
    UserMetadataKey.preferences => UserMetadata(userId: userId, key: key, preferences: Preferences.fromMap(value)),
    UserMetadataKey.license => UserMetadata(userId: userId, key: key, license: License.fromMap(value)),
  };
}
