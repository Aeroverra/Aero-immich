import 'package:drift/drift.dart' hide isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/data/db/main/table/remote/asset.drift.dart';
import 'package:immich_mobile/data/db/main/table/remote/stack.drift.dart';
import 'package:immich_mobile/data/db/main/table/user/user.drift.dart';
import 'package:immich_mobile/data/db/util/private_mode_filter.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/domain/models/stack.model.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';

PrivateModeFilter _filter(bool enabled, String userId) => PrivateModeFilter(enabled: enabled, userId: userId);

void main() {
  late Drift db;

  setUp(() {
    db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
  });

  tearDown(() async {
    await db.close();
  });

  Future<void> seedAsset({required String id, required String ownerId, bool isPrivate = false, String? stackId}) async {
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
            stackId: Value(stackId),
          ),
        );
  }

  Future<void> seedStack({
    required String id,
    required String ownerId,
    required List<String> assetIds,
    required StackSource source,
  }) async {
    await db
        .into(db.stackEntity)
        .insert(
          StackEntityCompanion.insert(id: id, ownerId: ownerId, primaryAssetId: assetIds.first, source: Value(source)),
        );
    for (final assetId in assetIds) {
      await seedAsset(id: assetId, ownerId: ownerId, stackId: id);
    }
  }

  Future<void> seedUser(String id) {
    return db.into(db.userEntity).insert(UserEntityCompanion.insert(id: id, email: '$id@test.dev', name: id));
  }

  group('automatic stacks', () {
    Future<void> seedStacks() async {
      await seedUser('me');
      await seedAsset(id: 'single', ownerId: 'me');
      await seedStack(id: 'manual', ownerId: 'me', assetIds: ['manual-1', 'manual-2'], source: StackSource.manual);
      await seedStack(id: 'auto', ownerId: 'me', assetIds: ['auto-1', 'auto-2', 'auto-3'], source: StackSource.auto);
    }

    test('are collapsed to their primary asset like manual stacks while grouped', () async {
      await seedStacks();

      final rows = await db.mergedAssetDrift
          .mergedAsset(
            userIds: ['me'],
            limit: (_) => Limit(10, 0),
            viewActive: false,
            showLocal: true,
            member_filter: (_, _, member) => member.privateFilter(_filter(false, 'me')),
            asset_filter: (asset, _) => asset.privateFilter(_filter(false, 'me')),
            groupAutoStacks: true,
          )
          .get();
      expect(rows.map((row) => row.remoteId), unorderedEquals(['single', 'manual-1', 'auto-1']));
      expect(rows.firstWhere((row) => row.remoteId == 'auto-1').stackId, 'auto');
      expect(rows.firstWhere((row) => row.remoteId == 'manual-1').stackId, 'manual');

      final buckets = await db.mergedAssetDrift
          .mergedBucket(
            groupBy: GroupAssetsBy.day.index,
            userIds: ['me'],
            viewActive: false,
            showLocal: true,
            member_filter: (_, _, member) => member.privateFilter(_filter(false, 'me')),
            asset_filter: (asset, _) => asset.privateFilter(_filter(false, 'me')),
            groupAutoStacks: true,
          )
          .get();
      expect(buckets.single.assetCount, 3);
    });

    test('list every asset without stack info while not grouped, manual stacks stay collapsed', () async {
      await seedStacks();

      final rows = await db.mergedAssetDrift
          .mergedAsset(
            userIds: ['me'],
            limit: (_) => Limit(10, 0),
            viewActive: false,
            showLocal: true,
            member_filter: (_, _, member) => member.privateFilter(_filter(false, 'me')),
            asset_filter: (asset, _) => asset.privateFilter(_filter(false, 'me')),
            groupAutoStacks: false,
          )
          .get();
      expect(rows.map((row) => row.remoteId), unorderedEquals(['single', 'manual-1', 'auto-1', 'auto-2', 'auto-3']));
      expect(rows.where((row) => row.remoteId!.startsWith('auto')).map((row) => row.stackId), everyElement(isNull));
      expect(rows.firstWhere((row) => row.remoteId == 'manual-1').stackId, 'manual');

      final buckets = await db.mergedAssetDrift
          .mergedBucket(
            groupBy: GroupAssetsBy.day.index,
            userIds: ['me'],
            viewActive: false,
            showLocal: true,
            member_filter: (_, _, member) => member.privateFilter(_filter(false, 'me')),
            asset_filter: (asset, _) => asset.privateFilter(_filter(false, 'me')),
            groupAutoStacks: false,
          )
          .get();
      expect(buckets.single.assetCount, 5);
    });
  });

  group('private mode', () {
    test('mergedAsset and mergedBucket hide private assets when off and show own ones when on', () async {
      await seedUser('me');
      await seedAsset(id: 'public', ownerId: 'me', isPrivate: false);
      await seedAsset(id: 'private', ownerId: 'me', isPrivate: true);

      final off = await db.mergedAssetDrift
          .mergedAsset(
            userIds: ['me'],
            limit: (_) => Limit(10, 0),
            viewActive: false,
            showLocal: true,
            member_filter: (_, _, member) => member.privateFilter(_filter(false, 'me')),
            asset_filter: (asset, _) => asset.privateFilter(_filter(false, 'me')),
            groupAutoStacks: true,
          )
          .get();
      expect(off.map((row) => row.remoteId), ['public']);
      final offBuckets = await db.mergedAssetDrift
          .mergedBucket(
            groupBy: GroupAssetsBy.day.index,
            userIds: ['me'],
            viewActive: false,
            showLocal: true,
            member_filter: (_, _, member) => member.privateFilter(_filter(false, 'me')),
            asset_filter: (asset, _) => asset.privateFilter(_filter(false, 'me')),
            groupAutoStacks: true,
          )
          .get();
      expect(offBuckets.single.assetCount, 1);

      final on = await db.mergedAssetDrift
          .mergedAsset(
            userIds: ['me'],
            limit: (_) => Limit(10, 0),
            viewActive: false,
            showLocal: true,
            member_filter: (_, _, member) => member.privateFilter(_filter(true, 'me')),
            asset_filter: (asset, _) => asset.privateFilter(_filter(true, 'me')),
            groupAutoStacks: true,
          )
          .get();
      expect(on.map((row) => row.remoteId), containsAll(['public', 'private']));
      expect(on.firstWhere((row) => row.remoteId == 'private').isPrivate, isTrue);
      final onBuckets = await db.mergedAssetDrift
          .mergedBucket(
            groupBy: GroupAssetsBy.day.index,
            userIds: ['me'],
            viewActive: false,
            showLocal: true,
            member_filter: (_, _, member) => member.privateFilter(_filter(true, 'me')),
            asset_filter: (asset, _) => asset.privateFilter(_filter(true, 'me')),
            groupAutoStacks: true,
          )
          .get();
      expect(onBuckets.single.assetCount, 2);
    });

    test('partner private assets stay hidden even when private mode is on', () async {
      await seedUser('me');
      await seedUser('partner');
      await seedAsset(id: 'partner-public', ownerId: 'partner', isPrivate: false);
      await seedAsset(id: 'partner-private', ownerId: 'partner', isPrivate: true);

      final rows = await db.mergedAssetDrift
          .mergedAsset(
            userIds: ['me', 'partner'],
            limit: (_) => Limit(10, 0),
            viewActive: false,
            showLocal: true,
            member_filter: (_, _, member) => member.privateFilter(_filter(true, 'me')),
            asset_filter: (asset, _) => asset.privateFilter(_filter(true, 'me')),
            groupAutoStacks: true,
          )
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
        .mergedBucket(
          groupBy: GroupAssetsBy.day.index,
          userIds: [userId],
          viewActive: false,
          showLocal: true,
          member_filter: (_, _, member) => member.privateFilter(_filter(false, '')),
          asset_filter: (asset, _) => asset.privateFilter(_filter(false, '')),
          groupAutoStacks: true,
        )
        .get();

    expect(buckets, hasLength(1));
    expect(buckets.single.assetCount, 1);
    expect(buckets.single.bucketDate, isNotEmpty);
  });
}
