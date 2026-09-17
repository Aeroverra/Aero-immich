import { Kysely } from 'kysely';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  AssetType,
  AssetVisibility,
  SyncEntityType,
  SyncRequestType,
  ViewAccess,
  ViewPrivateAssets,
  ViewTagMode,
} from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { CryptoRepository } from 'src/repositories/crypto.repository';
import { CustomViewRepository } from 'src/repositories/custom-view.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { SessionRepository } from 'src/repositories/session.repository';
import { TagRepository } from 'src/repositories/tag.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { DB } from 'src/schema';
import { CustomViewService } from 'src/services/custom-view.service';
import { WITHHELD_ACK_INTERVAL } from 'src/services/sync.service';
import { newMediumService, SyncTestContext } from 'test/medium.factory';
import { factory } from 'test/small.factory';
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

type SyncResponse = Array<{ type: string; ack: string; data: unknown }>;

/**
 * How the mobile apps consume a response: every run of consecutive events of one type is one batch, handled in one
 * database transaction and acknowledged with its last ack in one request.
 */
const toClientBatches = (response: SyncResponse) => {
  const batches: Array<{ type: string; count: number; ack: string }> = [];
  for (const { type, ack } of response) {
    const last = batches.at(-1);
    if (last?.type === type) {
      last.count++;
      last.ack = ack;
    } else {
      batches.push({ type, count: 1, ack });
    }
  }
  return batches;
};

const clientAck = async (ctx: SyncTestContext, auth: AuthDto, response: SyncResponse) => {
  for (const { ack } of toClientBatches(response)) {
    await ctx.sut.setAcks(auth, { acks: [ack] });
  }
};

/** the views endpoints for the user of a sync test, with private mode unlocked as editing views requires */
const newViewService = (userId: string) => {
  const { sut } = newMediumService(CustomViewService, {
    database: defaultDatabase,
    real: [AccessRepository, CryptoRepository, CustomViewRepository, SessionRepository, TagRepository, UserRepository],
    mock: [LoggingRepository],
  });
  const viewAuth = factory.auth({ user: { id: userId }, session: { privateMode: true } });
  return { views: sut, viewAuth };
};

/** a sync user with an Unreviewed tag and untagged assets that have exif */
const newTaggedLibrary = async (count: number) => {
  const { auth, user, ctx } = await setup();
  const { views, viewAuth } = newViewService(user.id);
  const unreviewed = await ctx.get(TagRepository).create({ userId: user.id, value: 'Unreviewed' });
  const assets = [];
  for (let i = 0; i < count; i++) {
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newExif({ assetId: asset.id, make: 'Canon' });
    assets.push(asset);
  }
  return { auth, user, ctx, views, viewAuth, unreviewed, assets };
};

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
  describe('default view changes for a client without the views flag', () => {
    const types = [SyncRequestType.AssetsV2, SyncRequestType.AssetExifsV1];

    it('should delete assets tagged before the default view rule was saved, in one batch', async () => {
      const { auth, ctx, views, viewAuth, unreviewed, assets } = await newTaggedLibrary(5);
      const assetIdList = assets.map(({ id }) => id).toSorted();

      // the live order: the assets are tagged, the official app syncs them while they are still visible...
      await ctx.newTagAsset({ tagIds: [unreviewed.id], assetIds: assetIdList });
      await clientAck(ctx, auth, await ctx.syncStream(auth, types));
      await ctx.assertSyncIsComplete(auth, types);

      // ...and only then the default view starts excluding the tag
      const view = await views.create(viewAuth, { name: 'Default', isDefault: true, includeAll: true });
      await ctx.assertSyncIsComplete(auth, types);
      await views.update(viewAuth, view.id, { excludeTagIds: [unreviewed.id] });

      const response = await ctx.syncStream(auth, types);
      expect(assetIds(response, SyncEntityType.AssetDeleteV1)).toEqual(assetIdList);
      expect(assetIds(response, SyncEntityType.AssetV2)).toEqual([]);
      // one delete batch and one ack, instead of a delete and an ack (two batches, two requests) per asset
      expect(toClientBatches(response).map(({ type, count }) => [type, count])).toEqual([
        [SyncEntityType.AssetDeleteV1, 5],
        [SyncEntityType.SyncAckV1, 1],
        [SyncEntityType.SyncCompleteV1, 1],
      ]);
      await clientAck(ctx, auth, response);
      await ctx.assertSyncIsComplete(auth, types);

      // removing the rule brings them back, exif included
      await views.update(viewAuth, view.id, { excludeTagIds: [] });
      const returning = await ctx.syncStream(auth, types);
      expect(assetIds(returning, SyncEntityType.AssetV2)).toEqual(assetIdList);
      expect(assetIds(returning, SyncEntityType.AssetExifV1)).toEqual(assetIdList);
      expect(assetIds(returning, SyncEntityType.AssetDeleteV1)).toEqual([]);
      await clientAck(ctx, auth, returning);
      await ctx.assertSyncIsComplete(auth, types);
    });

    it('should delete assets tagged after the default view rule was saved', async () => {
      const { auth, ctx, views, viewAuth, unreviewed, assets } = await newTaggedLibrary(3);
      const assetIdList = assets.map(({ id }) => id).toSorted();
      await clientAck(ctx, auth, await ctx.syncStream(auth, types));
      await views.create(viewAuth, {
        name: 'Default',
        isDefault: true,
        includeAll: true,
        excludeTagIds: [unreviewed.id],
      });
      await ctx.assertSyncIsComplete(auth, types);

      await ctx.newTagAsset({ tagIds: [unreviewed.id], assetIds: assetIdList });
      const response = await ctx.syncStream(auth, types);
      expect(assetIds(response, SyncEntityType.AssetDeleteV1)).toEqual(assetIdList);
      await clientAck(ctx, auth, response);
      await ctx.assertSyncIsComplete(auth, types);
    });

    it('should re-send assets when the default view is unset or deleted, and delete them when it is set', async () => {
      const { auth, ctx, views, viewAuth, unreviewed, assets } = await newTaggedLibrary(2);
      const assetIdList = assets.map(({ id }) => id).toSorted();
      await ctx.newTagAsset({ tagIds: [unreviewed.id], assetIds: assetIdList });
      const view = await views.create(viewAuth, {
        name: 'Default',
        isDefault: true,
        includeAll: true,
        excludeTagIds: [unreviewed.id],
      });
      await clientAck(ctx, auth, await ctx.syncStream(auth, types));
      await ctx.assertSyncIsComplete(auth, types);

      await views.update(viewAuth, view.id, { isDefault: false });
      const unset = await ctx.syncStream(auth, types);
      expect(assetIds(unset, SyncEntityType.AssetV2)).toEqual(assetIdList);
      await clientAck(ctx, auth, unset);

      await views.update(viewAuth, view.id, { isDefault: true });
      const set = await ctx.syncStream(auth, types);
      expect(assetIds(set, SyncEntityType.AssetDeleteV1)).toEqual(assetIdList);
      await clientAck(ctx, auth, set);

      await views.delete(viewAuth, view.id);
      const deleted = await ctx.syncStream(auth, types);
      expect(assetIds(deleted, SyncEntityType.AssetV2)).toEqual(assetIdList);
      await clientAck(ctx, auth, deleted);
      await ctx.assertSyncIsComplete(auth, types);
    });

    it('should still move the checkpoint during a long run of withheld assets', async () => {
      const { auth, ctx, views, viewAuth, unreviewed, assets } = await newTaggedLibrary(WITHHELD_ACK_INTERVAL + 2);
      await ctx.newTagAsset({ tagIds: [unreviewed.id], assetIds: assets.map(({ id }) => id) });
      await views.create(viewAuth, {
        name: 'Default',
        isDefault: true,
        includeAll: true,
        excludeTagIds: [unreviewed.id],
      });

      const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
      expect(toClientBatches(response).map(({ type, count }) => [type, count])).toEqual([
        [SyncEntityType.AssetDeleteV1, WITHHELD_ACK_INTERVAL],
        [SyncEntityType.SyncAckV1, 1],
        [SyncEntityType.AssetDeleteV1, 2],
        [SyncEntityType.SyncAckV1, 1],
        [SyncEntityType.SyncCompleteV1, 1],
      ]);
      await clientAck(ctx, auth, response);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
    });

    it('should keep checkpoints moving forward when withheld and visible assets alternate', async () => {
      const { auth, ctx, views, viewAuth, unreviewed, assets } = await newTaggedLibrary(4);
      await views.create(viewAuth, {
        name: 'Default',
        isDefault: true,
        includeAll: true,
        excludeTagIds: [unreviewed.id],
      });
      await ctx.newTagAsset({ tagIds: [unreviewed.id], assetIds: [assets[0].id, assets[2].id] });
      // touching them one by one interleaves hidden and visible assets in the stream
      for (const asset of assets) {
        await ctx.database.updateTable('asset').set({ updatedAt: new Date() }).where('id', '=', asset.id).execute();
        // update ids are only ordered across milliseconds
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
      expect(response.map(({ type }) => type)).toEqual([
        SyncEntityType.AssetDeleteV1,
        SyncEntityType.SyncAckV1,
        SyncEntityType.AssetV2,
        SyncEntityType.AssetDeleteV1,
        SyncEntityType.SyncAckV1,
        SyncEntityType.AssetV2,
        SyncEntityType.SyncCompleteV1,
      ]);
      await clientAck(ctx, auth, response);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
    });

    it('should not lose the ack of a withheld run when the next stream starts with a skipped row', async () => {
      const { auth, user, ctx, views, viewAuth, unreviewed, assets } = await newTaggedLibrary(3);
      const assetIdList = assets.map(({ id }) => id);
      const { person } = await ctx.newPerson({ ownerId: user.id });
      for (const assetId of assetIdList) {
        await ctx.newAssetFace({ assetId, personGroupId: person.personGroupId });
      }
      await ctx.newAlbum({ ownerId: user.id }, assetIdList);
      const allTypes = [
        SyncRequestType.AssetsV2,
        SyncRequestType.AlbumsV2,
        SyncRequestType.AlbumAssetsV2,
        SyncRequestType.AlbumToAssetsV1,
        SyncRequestType.AssetExifsV1,
        SyncRequestType.PeopleV1,
        SyncRequestType.AssetFacesV2,
      ];
      await clientAck(ctx, auth, await ctx.syncStream(auth, allTypes));
      await ctx.assertSyncIsComplete(auth, allTypes);

      await ctx.newTagAsset({ tagIds: [unreviewed.id], assetIds: assetIdList });
      await views.create(viewAuth, {
        name: 'Default',
        isDefault: true,
        includeAll: true,
        excludeTagIds: [unreviewed.id],
      });

      const response = await ctx.syncStream(auth, allTypes);
      const batches = toClientBatches(response);
      // checkpoint events of different streams never share a batch, where only the last ack would be kept
      for (const [index, batch] of batches.entries()) {
        if (index > 0) {
          expect(batch.type).not.toEqual(batches[index - 1].type);
        }
      }
      await clientAck(ctx, auth, response);
      await ctx.assertSyncIsComplete(auth, allTypes);
    });

    it('should withhold the motion part of a live photo together with its still', async () => {
      const { auth, user, ctx, views, viewAuth, unreviewed } = await newTaggedLibrary(0);
      const { asset: motion } = await ctx.newAsset({
        ownerId: user.id,
        type: AssetType.Video,
        visibility: AssetVisibility.Hidden,
      });
      const { asset: still } = await ctx.newAsset({ ownerId: user.id, livePhotoVideoId: motion.id });
      const { asset: otherMotion } = await ctx.newAsset({
        ownerId: user.id,
        type: AssetType.Video,
        visibility: AssetVisibility.Hidden,
      });
      await ctx.newAsset({ ownerId: user.id, livePhotoVideoId: otherMotion.id });
      await views.create(viewAuth, {
        name: 'Default',
        isDefault: true,
        includeAll: true,
        excludeTagIds: [unreviewed.id],
      });
      await clientAck(ctx, auth, await ctx.syncStream(auth, [SyncRequestType.AssetsV2]));

      // tagging only the still takes its untagged motion part along
      await ctx.newTagAsset({ tagIds: [unreviewed.id], assetIds: [still.id] });
      const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
      expect(assetIds(response, SyncEntityType.AssetDeleteV1)).toEqual([still.id, motion.id].toSorted());
      expect(assetIds(response, SyncEntityType.AssetV2)).toEqual([]);
      await clientAck(ctx, auth, response);

      await ctx.get(TagRepository).removeAssetIds(unreviewed.id, [still.id]);
      const returning = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
      expect(assetIds(returning, SyncEntityType.AssetV2)).toEqual([still.id, motion.id].toSorted());
    });
  });
});

const albumEvents = (response: SyncResponse, type: SyncEntityType) =>
  response
    .filter((item) => item.type === type)
    .map((item) => (item.data as { id?: string; albumId?: string }).id ?? (item.data as { albumId: string }).albumId);

const getAlbumRow = (albumId: string) =>
  defaultDatabase
    .selectFrom('album')
    .select(['updatedAt', 'updateId', 'albumThumbnailAssetId'])
    .where('id', '=', albumId)
    .executeTakeFirstOrThrow();

/** another session of the same user, with its own sync checkpoints */
const newSessionAuth = async (ctx: SyncTestContext, userId: string) => {
  const { session } = await ctx.newSession({ userId });
  return factory.auth({ session, user: { id: userId } });
};

describe('albums for a client without the views flag', () => {
  const types = [
    SyncRequestType.AlbumsV2,
    SyncRequestType.AlbumUsersV1,
    SyncRequestType.AlbumAssetsV2,
    SyncRequestType.AlbumToAssetsV1,
  ];

  it('should delete an album once the default view hides its last asset and send it again with its links', async () => {
    const { auth, user, ctx, gym, visible, hidden } = await newDefaultView();
    const { album } = await ctx.newAlbum({ ownerId: user.id }, [visible.id, hidden.id]);
    const { album: other } = await ctx.newAlbum({ ownerId: user.id }, [visible.id]);

    const first = await ctx.syncStream(auth, types);
    expect(albumEvents(first, SyncEntityType.AlbumV2).toSorted()).toEqual([album.id, other.id].toSorted());
    await clientAck(ctx, auth, first);
    await ctx.assertSyncIsComplete(auth, types);
    const before = await getAlbumRow(album.id);

    // the last visible asset of the album gets the excluded tag
    await ctx.newTagAsset({ tagIds: [gym.id], assetIds: [visible.id] });
    const leaving = await ctx.syncStream(auth, types);
    expect(albumEvents(leaving, SyncEntityType.AlbumDeleteV1).toSorted()).toEqual([album.id, other.id].toSorted());
    expect(albumEvents(leaving, SyncEntityType.AlbumV2)).toEqual([]);
    expect(albumEvents(leaving, SyncEntityType.AlbumUserV1)).toEqual([]);
    expect(albumEvents(leaving, SyncEntityType.AlbumToAssetV1)).toEqual([]);
    await clientAck(ctx, auth, leaving);
    await ctx.assertSyncIsComplete(auth, types);

    // the fork app (another session) still receives the album
    const fork = await ctx.syncStream(await newSessionAuth(ctx, user.id), types, false, false, true);
    expect(albumEvents(fork, SyncEntityType.AlbumV2).toSorted()).toEqual([album.id, other.id].toSorted());

    await ctx.get(TagRepository).removeAssetIds(gym.id, [visible.id]);
    const returning = await ctx.syncStream(auth, types);
    expect(albumEvents(returning, SyncEntityType.AlbumV2).toSorted()).toEqual([album.id, other.id].toSorted());
    expect(albumEvents(returning, SyncEntityType.AlbumUserV1).toSorted()).toEqual([album.id, other.id].toSorted());
    expect(
      returning
        .filter(({ type }) => type === SyncEntityType.AlbumToAssetV1)
        .map(({ data }) => data)
        .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ).toEqual(
      [
        { albumId: album.id, assetId: visible.id },
        { albumId: other.id, assetId: visible.id },
      ].toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
    // the returning album keeps its place in a list sorted by modification
    expect(returning).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: SyncEntityType.AlbumV2,
          data: expect.objectContaining({ id: album.id, updatedAt: before.updatedAt.toISOString() }),
        }),
      ]),
    );
    await clientAck(ctx, auth, returning);
    await ctx.assertSyncIsComplete(auth, types);

    const after = await getAlbumRow(album.id);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.updateId).not.toEqual(before.updateId);
  });

  it('should delete an album whose assets were tagged before the default view rule was saved', async () => {
    const { auth, user, ctx, views, viewAuth, unreviewed, assets } = await newTaggedLibrary(3);
    const { album } = await ctx.newAlbum({ ownerId: user.id }, [assets[0].id, assets[1].id]);
    const { album: kept } = await ctx.newAlbum({ ownerId: user.id }, [assets[1].id, assets[2].id]);
    const { album: empty } = await ctx.newAlbum({ ownerId: user.id });

    // the live order: tagged and synced while still visible, the rule comes afterwards
    await ctx.newTagAsset({ tagIds: [unreviewed.id], assetIds: [assets[0].id, assets[1].id] });
    await clientAck(ctx, auth, await ctx.syncStream(auth, types));
    await ctx.assertSyncIsComplete(auth, types);
    const keptBefore = await getAlbumRow(kept.id);

    await views.create(viewAuth, {
      name: 'Default',
      isDefault: true,
      includeAll: true,
      excludeTagIds: [unreviewed.id],
    });
    const response = await ctx.syncStream(auth, types);
    expect(albumEvents(response, SyncEntityType.AlbumDeleteV1)).toEqual([album.id]);
    // an album that still shows an asset is not sent again, and an album without assets stays
    expect(albumEvents(response, SyncEntityType.AlbumV2)).toEqual([]);
    await clientAck(ctx, auth, response);
    await ctx.assertSyncIsComplete(auth, types);

    const keptAfter = await getAlbumRow(kept.id);
    expect(keptAfter).toEqual(keptBefore);
    expect(empty.id).toBeDefined();

    // a later sync evaluates nothing again and sends nothing
    await ctx.assertSyncIsComplete(auth, types);
  });

  it('should replace an album cover the default view hides with the newest visible asset', async () => {
    const { auth, user, ctx } = await setup();
    const gym = await ctx.get(TagRepository).create({ userId: user.id, value: 'Gym' });
    const { asset: cover } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: new Date('2024-01-03') });
    const { asset: older } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: new Date('2024-01-01') });
    const { asset: newer } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: new Date('2024-01-02') });
    const { album } = await ctx.newAlbum({ ownerId: user.id, albumThumbnailAssetId: cover.id }, [
      cover.id,
      older.id,
      newer.id,
    ]);
    await ctx
      .get(CustomViewRepository)
      .create(
        { ownerId: user.id, name: 'Default', isDefault: true, includeAll: true },
        { includeTagIds: [], excludeTagIds: [gym.id] },
      );

    const first = await ctx.syncStream(auth, [SyncRequestType.AlbumsV2]);
    expect(first).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: SyncEntityType.AlbumV2,
          data: expect.objectContaining({ id: album.id, thumbnailAssetId: cover.id }),
        }),
      ]),
    );
    await clientAck(ctx, auth, first);
    const before = await getAlbumRow(album.id);

    await ctx.newTagAsset({ tagIds: [gym.id], assetIds: [cover.id] });
    const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV2]);
    expect(response).toEqual([
      expect.objectContaining({
        type: SyncEntityType.AlbumV2,
        data: expect.objectContaining({
          id: album.id,
          thumbnailAssetId: newer.id,
          updatedAt: before.updatedAt.toISOString(),
        }),
      }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await clientAck(ctx, auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV2]);

    // the album itself keeps its cover, and the fork app receives it unchanged
    const stored = await getAlbumRow(album.id);
    expect(stored.albumThumbnailAssetId).toEqual(cover.id);
    const fork = await ctx.syncStream(
      await newSessionAuth(ctx, user.id),
      [SyncRequestType.AlbumsV2],
      false,
      false,
      true,
    );
    expect(fork).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: SyncEntityType.AlbumV2,
          data: expect.objectContaining({ id: album.id, thumbnailAssetId: cover.id }),
        }),
      ]),
    );
    for (const { data } of fork) {
      expect(Object.keys(data as object)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/viewStateAlbumId|viewThumbnailAssetId|isViewHidden/)]),
      );
    }

    // the cover comes back once it is visible again
    await ctx.get(TagRepository).removeAssetIds(gym.id, [cover.id]);
    const returning = await ctx.syncStream(auth, [SyncRequestType.AlbumsV2]);
    expect(returning).toEqual([
      expect.objectContaining({
        type: SyncEntityType.AlbumV2,
        data: expect.objectContaining({ id: album.id, thumbnailAssetId: cover.id }),
      }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });

  it('should evaluate a shared album with the default view of each receiving user', async () => {
    const { auth: ownerAuth, user: owner, ctx } = await setup();
    const { auth: sharedAuth, user: shared } = await ctx.newSyncAuthUser();
    const ownerGym = await ctx.get(TagRepository).create({ userId: owner.id, value: 'Gym' });
    const sharedFamily = await ctx.get(TagRepository).create({ userId: shared.id, value: 'Family' });
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
    await ctx.newAlbumUser({ albumId: album.id, userId: shared.id });
    await ctx.newTagAsset({ tagIds: [ownerGym.id], assetIds: [asset.id] });

    const repository = ctx.get(CustomViewRepository);
    // the owner hides Gym
    await repository.create(
      { ownerId: owner.id, name: 'Default', isDefault: true, includeAll: true },
      { includeTagIds: [], excludeTagIds: [ownerGym.id] },
    );
    const ownerResponse = await ctx.syncStream(ownerAuth, [SyncRequestType.AlbumsV2]);
    expect(albumEvents(ownerResponse, SyncEntityType.AlbumDeleteV1)).toEqual([album.id]);

    // the tags of the owner mean nothing to the other user, whose view has no rule on them
    const sharedResponse = await ctx.syncStream(sharedAuth, [SyncRequestType.AlbumsV2]);
    expect(albumEvents(sharedResponse, SyncEntityType.AlbumV2)).toEqual([album.id]);
    await clientAck(ctx, sharedAuth, sharedResponse);

    // a view of the other user that only shows its own Family tag hides the owner's asset, which it sees as untagged
    await repository.create(
      { ownerId: shared.id, name: 'Default', isDefault: true, includeAll: false, includeUntagged: false },
      { includeTagIds: [sharedFamily.id], excludeTagIds: [] },
    );
    const hiddenForShared = await ctx.syncStream(sharedAuth, [SyncRequestType.AlbumsV2]);
    expect(albumEvents(hiddenForShared, SyncEntityType.AlbumDeleteV1)).toEqual([album.id]);
  });
});
