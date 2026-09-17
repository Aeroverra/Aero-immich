import { Kysely } from 'kysely';
import { SyncEntityType, SyncRequestType, ViewAccess, ViewPrivateAssets, ViewTagMode } from 'src/enum';
import { CustomViewRepository } from 'src/repositories/custom-view.repository';
import { TagRepository } from 'src/repositories/tag.repository';
import { DB } from 'src/schema';
import { SyncTestContext } from 'test/medium.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = async (db?: Kysely<DB>) => {
  const ctx = new SyncTestContext(db || defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  return { auth, user, session, ctx };
};

/** a default view that shows everything except the Gym tag, and three assets, one of them tagged Gym */
const newDefaultView = async () => {
  const { auth, user, ctx } = await setup();
  const gym = await ctx.get(TagRepository).create({ userId: user.id, value: 'Gym' });
  const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
  const { asset: other } = await ctx.newAsset({ ownerId: user.id });
  const { asset: hidden } = await ctx.newAsset({ ownerId: user.id });
  await ctx.newTagAsset({ tagIds: [gym.id], assetIds: [hidden.id] });
  const viewId = await ctx
    .get(CustomViewRepository)
    .create(
      { ownerId: user.id, name: 'Default', isDefault: true, includeAll: true },
      { includeTagIds: [], excludeTagIds: [gym.id] },
    );
  return { auth, user, ctx, gym, visible, other, hidden, viewId };
};

const assetIds = (response: Array<{ type: string; data: unknown }>, type: SyncEntityType) =>
  response
    .filter((item) => item.type === type)
    .map((item) => (item.data as { id?: string; assetId?: string }).id ?? (item.data as { assetId: string }).assetId)
    .toSorted();

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe('views sync compat', () => {
  it('should only send assets of the default view to a client without the views flag', async () => {
    const { auth, ctx, visible, other, hidden } = await newDefaultView();

    const official = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
    expect(assetIds(official, SyncEntityType.AssetV2)).toEqual([visible.id, other.id].toSorted());
    // the hidden asset is withheld with a delete, like a private asset
    expect(assetIds(official, SyncEntityType.AssetDeleteV1)).toEqual([hidden.id]);
  });

  it('should send everything to a client with the views flag', async () => {
    const { auth, ctx, visible, other, hidden } = await newDefaultView();

    const fork = await ctx.syncStream(auth, [SyncRequestType.AssetsV2], false, true, true);
    expect(assetIds(fork, SyncEntityType.AssetV2)).toEqual([visible.id, other.id, hidden.id].toSorted());
    expect(assetIds(fork, SyncEntityType.AssetDeleteV1)).toEqual([]);
  });

  it('should delete an asset once it leaves the default view and send it again when it returns', async () => {
    const { auth, ctx, gym, visible } = await newDefaultView();
    const types = [SyncRequestType.AssetsV2, SyncRequestType.AssetExifsV1];
    await ctx.newExif({ assetId: visible.id, make: 'Canon' });
    await ctx.syncAckAll(auth, await ctx.syncStream(auth, types));
    await ctx.assertSyncIsComplete(auth, types);

    await ctx.newTagAsset({ tagIds: [gym.id], assetIds: [visible.id] });
    const leaving = await ctx.syncStream(auth, types);
    expect(leaving).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: SyncEntityType.AssetDeleteV1, data: { assetId: visible.id } }),
        expect.objectContaining({ type: SyncEntityType.SyncAckV1 }),
      ]),
    );
    expect(assetIds(leaving, SyncEntityType.AssetV2)).toEqual([]);
    expect(assetIds(leaving, SyncEntityType.AssetExifV1)).toEqual([]);
    await ctx.syncAckAll(auth, leaving);
    await ctx.assertSyncIsComplete(auth, types);

    await ctx.get(TagRepository).removeAssetIds(gym.id, [visible.id]);
    const returning = await ctx.syncStream(auth, types);
    expect(assetIds(returning, SyncEntityType.AssetV2)).toEqual([visible.id]);
    expect(assetIds(returning, SyncEntityType.AssetExifV1)).toEqual([visible.id]);
    await ctx.syncAckAll(auth, returning);
    await ctx.assertSyncIsComplete(auth, types);
  });

  it('should re-evaluate assets when the default view rules change', async () => {
    const { auth, user, ctx, gym, hidden, viewId } = await newDefaultView();
    const types = [SyncRequestType.AssetsV2];
    await ctx.syncAckAll(auth, await ctx.syncStream(auth, types));
    await ctx.assertSyncIsComplete(auth, types);

    const repository = ctx.get(CustomViewRepository);
    const before = await repository.getDefault(user.id);
    await repository.update(viewId, user.id, {}, { includeTagIds: [], excludeTagIds: [] });
    const after = await repository.getDefault(user.id);
    const changed = await repository.getChangedAssetIds(user.id, before!, after!);
    expect(changed).toEqual([hidden.id]);
    await repository.touchAssets(changed);

    const response = await ctx.syncStream(auth, types);
    expect(assetIds(response, SyncEntityType.AssetV2)).toEqual([hidden.id]);
    expect(gym.id).toBeDefined();
  });

  it('should withhold album links, faces and stacks of assets the default view hides', async () => {
    const { auth, user, ctx, visible, hidden } = await newDefaultView();
    const { album } = await ctx.newAlbum({ ownerId: user.id }, [visible.id, hidden.id]);
    const { person } = await ctx.newPerson({ ownerId: user.id });
    await ctx.newAssetFace({ assetId: hidden.id, personGroupId: person.personGroupId });
    await ctx.newStack({ ownerId: user.id }, [hidden.id, visible.id]);

    const response = await ctx.syncStream(auth, [
      SyncRequestType.AlbumsV2,
      SyncRequestType.AlbumToAssetsV1,
      SyncRequestType.AssetFacesV2,
      SyncRequestType.PeopleV1,
      SyncRequestType.StacksV2,
    ]);
    expect(assetIds(response, SyncEntityType.AlbumToAssetV1)).toEqual([visible.id]);
    expect(response.filter(({ type }) => type === SyncEntityType.AssetFaceV2)).toHaveLength(0);
    expect(response.filter(({ type }) => type === SyncEntityType.StackV2)).toHaveLength(0);
    // the person only has a face on a hidden asset
    expect(response).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: SyncEntityType.PersonDeleteV1, data: { personId: person.personGroupId } }),
      ]),
    );
    expect(album.id).toBeDefined();
  });

  it('should not filter a client limited to a default view that shows everything', async () => {
    const { auth, user, ctx } = await setup();
    const { asset: first } = await ctx.newAsset({ ownerId: user.id });
    const { asset: second } = await ctx.newAsset({ ownerId: user.id, isPrivate: true });
    await ctx
      .get(CustomViewRepository)
      .create(
        { ownerId: user.id, name: 'Everything', isDefault: true, includeAll: true },
        { includeTagIds: [], excludeTagIds: [] },
      );

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV2], false, true);
    expect(assetIds(response, SyncEntityType.AssetV2)).toEqual([first.id, second.id].toSorted());
  });
});

describe(SyncRequestType.TagsV1, () => {
  it('should sync tags, hidden ones included, and their deletes', async () => {
    const { auth, user, ctx } = await setup();
    const repository = ctx.get(TagRepository);
    const parent = await repository.create({ userId: user.id, value: 'Secret', isHidden: true });
    const child = await repository.create({ userId: user.id, value: 'Secret/Deep', parentId: parent.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.TagsV1], false, true, true);
    expect(response).toEqual([
      expect.objectContaining({
        type: SyncEntityType.TagV1,
        data: expect.objectContaining({ id: parent.id, value: 'Secret', isHidden: true, parentId: null }),
      }),
      expect.objectContaining({
        type: SyncEntityType.TagV1,
        data: expect.objectContaining({ id: child.id, value: 'Secret/Deep', isHidden: false, parentId: parent.id }),
      }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.syncAckAll(auth, response);

    await repository.delete(parent.id);
    const deletes = await ctx.syncStream(auth, [SyncRequestType.TagsV1], false, true, true);
    expect(deletes.filter(({ type }) => type === SyncEntityType.TagDeleteV1).map(({ data }) => data)).toEqual(
      expect.arrayContaining([{ tagId: parent.id }]),
    );
  });

  it('should not sync the tags of another user', async () => {
    const { auth, ctx } = await setup();
    const { user: other } = await ctx.newUser();
    await ctx.get(TagRepository).create({ userId: other.id, value: 'Other' });
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.TagsV1]);
  });
});

describe(SyncRequestType.TagAssetsV1, () => {
  it('should sync tag links and their deletes', async () => {
    const { auth, user, ctx } = await setup();
    const tag = await ctx.get(TagRepository).create({ userId: user.id, value: 'Family' });
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });

    const response = await ctx.syncStream(auth, [SyncRequestType.TagAssetsV1], false, true, true);
    expect(response).toEqual([
      expect.objectContaining({ type: SyncEntityType.TagAssetV1, data: { tagId: tag.id, assetId: asset.id } }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.syncAckAll(auth, response);

    await ctx.get(TagRepository).removeAssetIds(tag.id, [asset.id]);
    const deletes = await ctx.syncStream(auth, [SyncRequestType.TagAssetsV1], false, true, true);
    expect(deletes).toEqual([
      expect.objectContaining({ type: SyncEntityType.TagAssetDeleteV1, data: { tagId: tag.id, assetId: asset.id } }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });
});

describe(SyncRequestType.ViewsV1, () => {
  it('should sync views, their tag rules and deletes', async () => {
    const { auth, user, ctx } = await setup();
    const include = await ctx.get(TagRepository).create({ userId: user.id, value: 'Family' });
    const exclude = await ctx.get(TagRepository).create({ userId: user.id, value: 'Gym' });
    const repository = ctx.get(CustomViewRepository);
    const viewId = await repository.create(
      {
        ownerId: user.id,
        name: 'Family',
        access: ViewAccess.Locked,
        privateAssets: ViewPrivateAssets.Hide,
      },
      { includeTagIds: [include.id], excludeTagIds: [exclude.id] },
    );

    const types = [SyncRequestType.ViewsV1, SyncRequestType.ViewTagsV1];
    const response = await ctx.syncStream(auth, types, false, true, true);
    expect(response).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: SyncEntityType.ViewV1,
          data: expect.objectContaining({
            id: viewId,
            name: 'Family',
            access: ViewAccess.Locked,
            privateAssets: ViewPrivateAssets.Hide,
            isDefault: false,
          }),
        }),
        expect.objectContaining({
          type: SyncEntityType.ViewTagV1,
          data: { viewId, tagId: include.id, mode: ViewTagMode.Include },
        }),
        expect.objectContaining({
          type: SyncEntityType.ViewTagV1,
          data: { viewId, tagId: exclude.id, mode: ViewTagMode.Exclude },
        }),
      ]),
    );
    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, types);

    // dropping the exclude rule deletes only that row
    await repository.update(viewId, user.id, {}, { includeTagIds: [include.id], excludeTagIds: [] });
    const changed = await ctx.syncStream(auth, types, false, true, true);
    expect(changed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: SyncEntityType.ViewV1, data: expect.objectContaining({ id: viewId }) }),
        expect.objectContaining({ type: SyncEntityType.ViewTagDeleteV1, data: { viewId, tagId: exclude.id } }),
      ]),
    );
    expect(changed.filter(({ type }) => type === SyncEntityType.ViewTagV1)).toHaveLength(0);
    await ctx.syncAckAll(auth, changed);

    await repository.delete(viewId);
    const deleted = await ctx.syncStream(auth, types, false, true, true);
    expect(deleted).toEqual([
      expect.objectContaining({ type: SyncEntityType.ViewDeleteV1, data: { viewId } }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });
});
