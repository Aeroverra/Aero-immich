import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/data/db/main/table/remote/asset.drift.dart';
import 'package:immich_mobile/data/db/main/table/user/user.drift.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';

void main() {
  late Drift db;

  setUp(() {
    db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
  });

  tearDown(() async {
    await db.close();
  });

  Future<void> seedAsset({required String id, required String ownerId, required bool isPrivate}) async {
    final createdAt = DateTime(2024, 1, 1, 12);
    await db
        .into(db.remoteAssetEntity)
        .insert(
          RemoteAssetEntityCompanion.insert(
            id: id,
            name: '$id.jpg',
            type: AssetType.image,
            checksum: 'checksum-$id',
            ownerId: ownerId,
            visibility: AssetVisibility.timeline,
            createdAt: Value(createdAt),
            updatedAt: Value(createdAt),
            uploadedAt: Value(createdAt),
            isPrivate: Value(isPrivate),
          ),
        );
  }

  Future<void> seedUser(String id) {
    return db.into(db.userEntity).insert(UserEntityCompanion.insert(id: id, email: '$id@test.dev', name: id));
  }

  group('private mode', () {
    test('mergedAsset and mergedBucket hide private assets when off and show own ones when on', () async {
      await seedUser('me');
      await seedAsset(id: 'public', ownerId: 'me', isPrivate: false);
      await seedAsset(id: 'private', ownerId: 'me', isPrivate: true);

      final off = await db.mergedAssetDrift
          .mergedAsset(userIds: ['me'], limit: (_) => Limit(10, 0), privateMode: false, currentUserId: 'me')
          .get();
      expect(off.map((row) => row.remoteId), ['public']);
      final offBuckets = await db.mergedAssetDrift
          .mergedBucket(groupBy: GroupAssetsBy.day.index, userIds: ['me'], privateMode: false, currentUserId: 'me')
          .get();
      expect(offBuckets.single.assetCount, 1);

      final on = await db.mergedAssetDrift
          .mergedAsset(userIds: ['me'], limit: (_) => Limit(10, 0), privateMode: true, currentUserId: 'me')
          .get();
      expect(on.map((row) => row.remoteId), containsAll(['public', 'private']));
      expect(on.firstWhere((row) => row.remoteId == 'private').isPrivate, isTrue);
      final onBuckets = await db.mergedAssetDrift
          .mergedBucket(groupBy: GroupAssetsBy.day.index, userIds: ['me'], privateMode: true, currentUserId: 'me')
          .get();
      expect(onBuckets.single.assetCount, 2);
    });

    test('partner private assets stay hidden even when private mode is on', () async {
      await seedUser('me');
      await seedUser('partner');
      await seedAsset(id: 'partner-public', ownerId: 'partner', isPrivate: false);
      await seedAsset(id: 'partner-private', ownerId: 'partner', isPrivate: true);

      final rows = await db.mergedAssetDrift
          .mergedAsset(userIds: ['me', 'partner'], limit: (_) => Limit(10, 0), privateMode: true, currentUserId: 'me')
          .get();
      expect(rows.map((row) => row.remoteId), ['partner-public']);
    });
  });

  test('mergedBucket falls back to createdAt when localDateTime is null', () async {
    const userId = 'user-1';
    final createdAt = DateTime(2024, 1, 1, 12);

    await db
        .into(db.userEntity)
        .insert(UserEntityCompanion.insert(id: userId, email: 'user-1@test.dev', name: 'User 1'));

    await db
        .into(db.remoteAssetEntity)
        .insert(
          RemoteAssetEntityCompanion.insert(
            id: 'asset-1',
            name: 'asset-1.jpg',
            type: AssetType.image,
            checksum: 'checksum-1',
            ownerId: userId,
            visibility: AssetVisibility.timeline,
            createdAt: Value(createdAt),
            updatedAt: Value(createdAt),
            uploadedAt: Value(createdAt),
            localDateTime: const Value(null),
          ),
        );

    final buckets = await db.mergedAssetDrift
        .mergedBucket(groupBy: GroupAssetsBy.day.index, userIds: [userId], privateMode: false, currentUserId: '')
        .get();

    expect(buckets, hasLength(1));
    expect(buckets.single.assetCount, 1);
    expect(buckets.single.bucketDate, isNotEmpty);
  });
}
