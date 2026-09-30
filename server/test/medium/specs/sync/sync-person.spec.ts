import { Kysely } from 'kysely';
import { SyncEntityType, SyncRequestType } from 'src/enum';
import { AssetRepository } from 'src/repositories/asset.repository';
import { PersonRepository } from 'src/repositories/person.repository';
import { DB } from 'src/schema';
import { SyncTestContext } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = async (db?: Kysely<DB>) => {
  const ctx = new SyncTestContext(db || defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  return { auth, user, session, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(SyncEntityType.PersonV1, () => {
  it('should detect and sync the first person', async () => {
    const { auth, ctx } = await setup();
    const { person } = await ctx.newPerson({ ownerId: auth.user.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.PeopleV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({
          id: person.personGroupId,
          name: person.name,
          isHidden: person.isHidden,
          birthDate: person.birthDate,
          faceAssetId: person.faceAssetId,
          isFavorite: person.isFavorite,
          ownerId: auth.user.id,
          color: person.color,
        }),
        type: 'PersonV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.PeopleV1]);
  });

  it('should detect and sync a deleted person', async () => {
    const { auth, ctx } = await setup();
    const personRepo = ctx.get(PersonRepository);
    const { person } = await ctx.newPerson({ ownerId: auth.user.id });
    await personRepo.delete([person.personGroupId], person.ownerId);

    const response = await ctx.syncStream(auth, [SyncRequestType.PeopleV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          personId: person.personGroupId,
        },
        type: 'PersonDeleteV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.PeopleV1]);
  });

  it('should not sync a person or person delete for an unrelated user', async () => {
    const { auth, ctx } = await setup();
    const personRepo = ctx.get(PersonRepository);
    const { user: user2 } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user2.id });
    const { person } = await ctx.newPerson({ ownerId: user2.id });
    const auth2 = factory.auth({ session, user: user2 });

    expect(await ctx.syncStream(auth2, [SyncRequestType.PeopleV1])).toEqual([
      expect.objectContaining({ type: SyncEntityType.PersonV1 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.PeopleV1]);

    await personRepo.delete([person.personGroupId], person.ownerId);

    expect(await ctx.syncStream(auth2, [SyncRequestType.PeopleV1])).toEqual([
      expect.objectContaining({ type: SyncEntityType.PersonDeleteV1 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.PeopleV1]);
  });
  describe('private assets and the includePrivate flag', () => {
    it('should replace a person with a delete once every face is on a private asset, and send them again once one is public', async () => {
      const { auth, ctx } = await setup();
      const assetRepo = ctx.get(AssetRepository);
      const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
      const { person } = await ctx.newPerson({ ownerId: auth.user.id });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      const initial = await ctx.syncStream(auth, [SyncRequestType.PeopleV1]);
      expect(initial).toEqual([
        expect.objectContaining({
          type: SyncEntityType.PersonV1,
          data: expect.objectContaining({ id: person.personGroupId }),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, initial);

      await assetRepo.updateAll([asset.id], { isPrivate: true });
      await assetRepo.touchPrivateRelations([asset.id]);
      const hidden = await ctx.syncStream(auth, [SyncRequestType.PeopleV1]);
      expect(hidden).toEqual([
        {
          ack: expect.stringContaining(SyncEntityType.PersonDeleteV1),
          data: { personId: person.personGroupId },
          type: SyncEntityType.PersonDeleteV1,
        },
        expect.objectContaining({
          type: SyncEntityType.SyncAckV1,
          ack: expect.stringContaining(SyncEntityType.PersonV1),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, hidden);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.PeopleV1]);

      await assetRepo.updateAll([asset.id], { isPrivate: false });
      await assetRepo.touchPrivateRelations([asset.id]);
      const restored = await ctx.syncStream(auth, [SyncRequestType.PeopleV1]);
      expect(restored).toEqual([
        expect.objectContaining({
          type: SyncEntityType.PersonV1,
          data: expect.objectContaining({ id: person.personGroupId }),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, restored);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.PeopleV1]);
    });

    it('should keep sending a person who also has a face on a non-private asset', async () => {
      const { auth, ctx } = await setup();
      const { asset: hidden } = await ctx.newAsset({ ownerId: auth.user.id, isPrivate: true });
      const { asset: visible } = await ctx.newAsset({ ownerId: auth.user.id });
      const { person } = await ctx.newPerson({ ownerId: auth.user.id });
      await ctx.newAssetFace({ assetId: hidden.id, personGroupId: person.personGroupId });
      await ctx.newAssetFace({ assetId: visible.id, personGroupId: person.personGroupId });

      await expect(ctx.syncStream(auth, [SyncRequestType.PeopleV1])).resolves.toEqual([
        expect.objectContaining({
          type: SyncEntityType.PersonV1,
          data: expect.objectContaining({ id: person.personGroupId }),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
    });

    it('should carry a person whose faces are all on private assets for a client that opted in', async () => {
      const { auth, ctx } = await setup();
      const { asset } = await ctx.newAsset({ ownerId: auth.user.id, isPrivate: true });
      const { person } = await ctx.newPerson({ ownerId: auth.user.id });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      const response = await ctx.syncStream(auth, [SyncRequestType.PeopleV1]);
      expect(response.map(({ type }) => type)).not.toContain(SyncEntityType.PersonV1);

      await expect(ctx.syncStream(auth, [SyncRequestType.PeopleV1], false, true)).resolves.toEqual([
        expect.objectContaining({
          type: SyncEntityType.PersonV1,
          data: expect.objectContaining({ id: person.personGroupId }),
        }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
    });
  });
});
