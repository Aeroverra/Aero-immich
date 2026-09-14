import 'package:drift/drift.dart' hide isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/data/db/main/table/user/metadata.drift.dart';
import 'package:immich_mobile/data/db/main/table/user/user.drift.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/infrastructure/repositories/user_metadata.repository.dart';

void main() {
  const userId = 'user-1';
  late Drift db;
  late UserMetadataRepository sut;

  setUp(() async {
    db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    sut = UserMetadataRepository(db);
    await db.into(db.userEntity).insert(UserEntityCompanion.insert(id: userId, name: 'User', email: 'user@test'));
  });

  tearDown(() async {
    await db.close();
  });

  group('stack action mode', () {
    test('asks while no preferences are synced', () async {
      expect(await sut.getStackActionMode(userId), StackActionMode.ask);
    });

    test('reads the mode from the synced preferences', () async {
      await db
          .into(db.userMetadataEntity)
          .insert(
            UserMetadataEntityCompanion.insert(
              userId: userId,
              key: UserMetadataKey.preferences,
              value: {
                'stackActions': {'mode': 'primary'},
              },
            ),
          );

      expect(await sut.getStackActionMode(userId), StackActionMode.primary);
    });

    test('stores a new mode and keeps the other synced preferences', () async {
      await db
          .into(db.userMetadataEntity)
          .insert(
            UserMetadataEntityCompanion.insert(
              userId: userId,
              key: UserMetadataKey.preferences,
              value: {
                'tags': {'enabled': true},
              },
            ),
          );

      await sut.setStackActionMode(userId, StackActionMode.stack);

      expect(await sut.getStackActionMode(userId), StackActionMode.stack);
      final preferences = (await sut.getUserMetadata(userId)).single.preferences!;
      expect(preferences.tagsEnabled, isTrue);
    });

    test('falls back to asking for an unknown mode', () {
      expect(
        Preferences.fromMap({
          'stackActions': {'mode': 'something-new'},
        }).stackActionMode,
        StackActionMode.ask,
      );
    });
  });
}
