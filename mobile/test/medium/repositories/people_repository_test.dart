import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/dao/person.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';

import '../repository_context.dart';

void main() {
  late MediumRepositoryContext ctx;
  late PeopleRepository sut;

  setUp(() {
    ctx = MediumRepositoryContext();
    sut = PeopleRepository(ctx.db);
  });

  tearDown(() async {
    await ctx.dispose();
  });

  group('watch with private mode', () {
    test('a person seen only on private assets is hidden while off and listed when on', () async {
      final user = await ctx.newUser();
      final person = await ctx.newPerson(ownerId: user.id, name: 'Hidden');
      for (var i = 0; i < 3; i++) {
        final asset = await ctx.newRemoteAsset(ownerId: user.id, isPrivate: true);
        await ctx.newFace(assetId: asset.id, personId: person.id);
      }

      expect(await sut.watch().first, isEmpty);

      final on = await sut.watch(privateFilter: PrivateModeFilter(enabled: true, userId: user.id)).first;
      expect(on.map((p) => p.id), [person.id]);
    });

    test('a partner private asset never counts towards the person', () async {
      final user = await ctx.newUser();
      final partner = await ctx.newUser();
      final person = await ctx.newPerson(ownerId: partner.id, name: 'Partner face');
      final asset = await ctx.newRemoteAsset(ownerId: partner.id, isPrivate: true);
      await ctx.newFace(assetId: asset.id, personId: person.id);

      expect(await sut.watch(privateFilter: PrivateModeFilter(enabled: true, userId: user.id)).first, isEmpty);
    });
  });

  group('getAssetPeople', () {
    test('does not duplicate a person with multiple face records on the same asset', () async {
      // Regression check for #20585: a join on asset_face_entity returned one row
      // per face, so a person appeared twice in the asset details panel when the
      // same face was on the asset more than once (e.g., metadata import + ML)
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(ownerId: user.id);

      final person = await ctx.newPerson(ownerId: user.id);
      await ctx.newFace(assetId: asset.id, personId: person.id);
      await ctx.newFace(assetId: asset.id, personId: person.id);

      final people = await sut.getAssetPeople(asset.id);

      expect(people, hasLength(1));
      expect(people.single.id, person.id);
    });

    test('returns all distinct people of an asset', () async {
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(ownerId: user.id);

      final person1 = await ctx.newPerson(ownerId: user.id);
      final person2 = await ctx.newPerson(ownerId: user.id);
      await ctx.newFace(assetId: asset.id, personId: person1.id);
      await ctx.newFace(assetId: asset.id, personId: person2.id);

      final people = await sut.getAssetPeople(asset.id);

      expect(people, hasLength(2));
      expect(people.map((person) => person.id), containsAll([person1.id, person2.id]));
    });

    test('does not return hidden people', () async {
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(ownerId: user.id);

      final hidden = await ctx.newPerson(ownerId: user.id, isHidden: true);
      await ctx.newFace(assetId: asset.id, personId: hidden.id);

      final people = await sut.getAssetPeople(asset.id);

      expect(people, isEmpty);
    });

    test('does not return people from other assets', () async {
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(ownerId: user.id);
      final otherAsset = await ctx.newRemoteAsset(ownerId: user.id);

      final person = await ctx.newPerson(ownerId: user.id);
      await ctx.newFace(assetId: otherAsset.id, personId: person.id);

      final people = await sut.getAssetPeople(asset.id);

      expect(people, isEmpty);
    });
  });
}
