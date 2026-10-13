import 'package:drift/drift.dart' hide isNull;
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/stack.model.dart';
import 'package:immich_mobile/infrastructure/repositories/remote_asset.repository.dart';

import '../repository_context.dart';

void main() {
  late MediumRepositoryContext ctx;
  late RemoteAssetRepository sut;

  setUp(() {
    ctx = MediumRepositoryContext();
    sut = RemoteAssetRepository(ctx.db);
  });

  tearDown(() async {
    await ctx.dispose();
  });

  group('getByChecksum', () {
    late String userId;

    setUp(() async {
      final user = await ctx.newUser();
      userId = user.id;
      await ctx.newAuthUser(id: userId);
    });

    test('returns all assets when a partner shares the checksum', () async {
      const checksum = 'shared-partner-checksum';
      final mine = await ctx.newRemoteAsset(ownerId: userId, checksum: checksum);
      final partner = await ctx.newUser();
      final theirs = await ctx.newRemoteAsset(ownerId: partner.id, checksum: checksum);

      final result = await sut.getAllDebugForChecksum(checksum);
      final mineResult = result.firstWhere((asset) => asset.id == mine.id);
      final theirResult = result.firstWhere((asset) => asset.id == theirs.id);

      expect(result, isNotEmpty);
      expect(mineResult.id, mine.id);
      expect(mineResult.ownerId, userId);

      expect(theirResult.id, theirs.id);
      expect(theirResult.ownerId, partner.id);
    });

    test('returns partner asset only if there is no matching user asset', () async {
      const checksum = 'partner-only';
      final partner = await ctx.newUser();
      final theirs = await ctx.newRemoteAsset(ownerId: partner.id, checksum: checksum);

      final result = await sut.getAllDebugForChecksum(checksum);

      expect(result.length, 1);
      expect(result[0].id, theirs.id);
    });

    test('returns the current user\'s asset', () async {
      const checksum = 'simple';
      final remote = await ctx.newRemoteAsset(ownerId: userId, checksum: checksum);

      final result = await sut.getAllDebugForChecksum(checksum);

      expect(result.length, 1);
      expect(result[0].id, remote.id);
    });
  });

  group('getStackAssets', () {
    late String userId;
    late String manualStackId;
    late String autoStackId;
    late Set<String> manualIds;
    late Set<String> autoIds;

    setUp(() async {
      final user = await ctx.newUser();
      userId = user.id;

      final manualPrimary = await ctx.newRemoteAsset(ownerId: userId);
      manualStackId = (await ctx.newStack(ownerId: userId, primaryAssetId: manualPrimary.id)).id;
      final manualMember = await ctx.newRemoteAsset(ownerId: userId, stackId: manualStackId);
      await ctx.db.update(ctx.db.remoteAssetEntity).replace(manualPrimary.copyWith(stackId: Value(manualStackId)));
      manualIds = {manualPrimary.id, manualMember.id};

      final autoPrimary = await ctx.newRemoteAsset(ownerId: userId);
      autoStackId = (await ctx.newStack(ownerId: userId, primaryAssetId: autoPrimary.id, source: StackSource.auto)).id;
      final autoMember = await ctx.newRemoteAsset(ownerId: userId, stackId: autoStackId);
      await ctx.db.update(ctx.db.remoteAssetEntity).replace(autoPrimary.copyWith(stackId: Value(autoStackId)));
      autoIds = {autoPrimary.id, autoMember.id};
    });

    test('returns the assets of manual and automatic stacks', () async {
      final result = await sut.getStackAssets([manualStackId, autoStackId]);

      expect(result.map((asset) => asset.id).toSet(), {...manualIds, ...autoIds});
    });

    test('leaves out automatic stacks when they are shown as separate assets', () async {
      final result = await sut.getStackAssets([manualStackId, autoStackId], includeAutoStacks: false);

      expect(result.map((asset) => asset.id).toSet(), manualIds);
    });

    test('keeps assets of stacks that are not synced yet', () async {
      final orphan = await ctx.newRemoteAsset(ownerId: userId, stackId: 'unknown-stack');

      final result = await sut.getStackAssets(['unknown-stack'], includeAutoStacks: false);

      expect(result.map((asset) => asset.id), [orphan.id]);
    });
  });
}
