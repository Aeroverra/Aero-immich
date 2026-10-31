import { Kysely } from 'kysely';
import { AssetMediaStatus, AssetRejectReason, AssetUploadAction } from 'src/dtos/asset-media-response.dto';
import {
  AssetMetadataKey,
  AssetStatus,
  AssetVisibility,
  DeletedReimportMode,
  JobStatus,
  NotificationType,
  UserMetadataKey,
} from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetDeletedChecksumRepository } from 'src/repositories/asset-deleted-checksum.repository';
import { AssetJobRepository } from 'src/repositories/asset-job.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { NotificationRepository } from 'src/repositories/notification.repository';
import { StackRepository } from 'src/repositories/stack.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { TrashRepository } from 'src/repositories/trash.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { WebsocketRepository } from 'src/repositories/websocket.repository';
import { DB } from 'src/schema';
import { AlbumService } from 'src/services/album.service';
import { AssetMediaService, DELETED_REIMPORT_ALBUM_NAME } from 'src/services/asset-media.service';
import { AssetService } from 'src/services/asset.service';
import { NotificationService } from 'src/services/notification.service';
import { TrashService } from 'src/services/trash.service';
import { mediumFactory, newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const setPreferences = async (db: Kysely<DB>, userId: string, mode: DeletedReimportMode) => {
  await new UserRepository(db).upsertMetadata(userId, {
    key: UserMetadataKey.Preferences,
    value: { deletedReimport: { mode } },
  });
};

const getRemembered = (db: Kysely<DB>, ownerId: string) =>
  db.selectFrom('asset_deleted_checksum').selectAll().where('ownerId', '=', ownerId).execute();

const setupAssetService = (db?: Kysely<DB>) => {
  const result = newMediumService(AssetService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AssetRepository,
      AssetDeletedChecksumRepository,
      AssetJobRepository,
      StackRepository,
      UserRepository,
    ],
    mock: [EventRepository, LoggingRepository, JobRepository, StorageRepository],
  });
  result.ctx.getMock(EventRepository).emit.mockResolvedValue();
  result.ctx.getMock(JobRepository).queue.mockResolvedValue();
  return result;
};

const setupTrashService = (db?: Kysely<DB>) => {
  const result = newMediumService(TrashService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AssetDeletedChecksumRepository, TrashRepository],
    mock: [EventRepository, LoggingRepository, JobRepository],
  });
  result.ctx.getMock(EventRepository).emit.mockResolvedValue();
  return result;
};

const setupAssetMediaService = (db?: Kysely<DB>) => {
  const result = newMediumService(AssetMediaService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AlbumRepository, AssetRepository, AssetDeletedChecksumRepository, UserRepository],
    mock: [EventRepository, LoggingRepository, JobRepository, StorageRepository],
  });
  result.ctx.getMock(StorageRepository).utimes.mockResolvedValue();
  result.ctx.getMock(EventRepository).emit.mockResolvedValue();
  result.ctx.getMock(JobRepository).queue.mockResolvedValue();
  return result;
};

const setupAlbumService = (db?: Kysely<DB>) => {
  const result = newMediumService(AlbumService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AlbumRepository, AssetDeletedChecksumRepository, UserRepository],
    mock: [EventRepository, LoggingRepository],
  });
  result.ctx.getMock(EventRepository).emit.mockResolvedValue();
  return result;
};

const setupNotificationService = (db?: Kysely<DB>) =>
  newMediumService(NotificationService, {
    database: db || defaultDatabase,
    real: [AssetDeletedChecksumRepository, NotificationRepository, UserRepository],
    mock: [EventRepository, JobRepository, LoggingRepository, WebsocketRepository],
  });

describe('deleted re-import', () => {
  describe(AssetService.name, () => {
    it('should remember the checksum when an uploaded asset is permanently deleted', async () => {
      const { sut, ctx } = setupAssetService();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'IMG_0001.jpg' });

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      await expect(getRemembered(ctx.database, user.id)).resolves.toEqual([
        expect.objectContaining({
          checksum: asset.checksum,
          assetId: asset.id,
          originalFileName: 'IMG_0001.jpg',
          reimportedAt: null,
          notifiedAt: null,
        }),
      ]);
      await expect(
        ctx.database.selectFrom('asset').select('id').where('id', '=', asset.id).executeTakeFirst(),
      ).resolves.toBeUndefined();
    });

    it('should not remember an external library asset or a motion video', async () => {
      const { sut, ctx } = setupAssetService();
      const { user } = await ctx.newUser();
      const { id: libraryId } = await ctx.database
        .insertInto('library')
        .values({ ownerId: user.id, name: 'external', importPaths: [], exclusionPatterns: [] })
        .returning('id')
        .executeTakeFirstOrThrow();
      const { asset: external } = await ctx.newAsset({ ownerId: user.id, libraryId });
      const { asset: motion } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Hidden });

      await sut.handleAssetDeletion({ id: external.id, deleteOnDisk: false });
      await sut.handleAssetDeletion({ id: motion.id, deleteOnDisk: true });

      await expect(getRemembered(ctx.database, user.id)).resolves.toEqual([]);
    });

    it('should not remember anything when an asset is only moved to the trash', async () => {
      const { sut, ctx } = setupAssetService();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.deleteAll(factory.auth({ user: { id: user.id } }), { ids: [asset.id], force: false });

      await expect(
        ctx.database.selectFrom('asset').select('status').where('id', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: AssetStatus.Trashed });
      await expect(getRemembered(ctx.database, user.id)).resolves.toEqual([]);
    });
  });

  describe(TrashService.name, () => {
    it('should forget the checksum of an asset restored from the trash', async () => {
      const { sut, ctx } = setupTrashService();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, status: AssetStatus.Trashed, deletedAt: new Date() });
      const { asset: other } = await ctx.newAsset({
        ownerId: user.id,
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      const repository = ctx.get(AssetDeletedChecksumRepository);
      for (const { checksum, id } of [asset, other]) {
        await repository.upsert({ ownerId: user.id, checksum, assetId: id, originalFileName: 'a.jpg' });
      }

      await sut.restoreAssets(factory.auth({ user: { id: user.id } }), { ids: [asset.id] });

      await expect(getRemembered(ctx.database, user.id)).resolves.toEqual([
        expect.objectContaining({ checksum: other.checksum }),
      ]);
    });

    it('should forget every trashed checksum when the whole trash is restored', async () => {
      const { sut, ctx } = setupTrashService();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, status: AssetStatus.Trashed, deletedAt: new Date() });
      const repository = ctx.get(AssetDeletedChecksumRepository);
      await repository.upsert({ ownerId: user.id, checksum: asset.checksum, assetId: asset.id, originalFileName: 'a' });
      await repository.upsert({
        ownerId: user.id,
        checksum: Buffer.from('never re-uploaded'),
        assetId: asset.id,
        originalFileName: 'b',
      });

      await expect(sut.restore(factory.auth({ user: { id: user.id } }))).resolves.toEqual({ count: 1 });

      await expect(getRemembered(ctx.database, user.id)).resolves.toEqual([
        expect.objectContaining({ originalFileName: 'b' }),
      ]);
    });
  });

  describe(AssetMediaService.name, () => {
    const dto = { fileModifiedAt: new Date(), fileCreatedAt: new Date(), assetData: Buffer.from('some data') };

    const remember = async (
      ctx: ReturnType<typeof setupAssetMediaService>['ctx'],
      ownerId: string,
      checksum: Buffer,
    ) => {
      const assetId = factory.uuid();
      await ctx
        .get(AssetDeletedChecksumRepository)
        .upsert({ ownerId, checksum, assetId, originalFileName: 'IMG_0001.jpg' });
      return assetId;
    };

    it('should store and trash the upload by default', async () => {
      const { sut, ctx } = setupAssetMediaService();
      const { user } = await ctx.newUser();
      const file = mediumFactory.uploadFile();
      await remember(ctx, user.id, file.checksum);

      const response = await sut.uploadAsset(factory.auth({ user: { id: user.id } }), dto, file);

      expect(response.status).toBe(AssetMediaStatus.CREATED);
      await expect(
        ctx.database
          .selectFrom('asset')
          .select(['status', 'deletedAt'])
          .where('id', '=', response.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: AssetStatus.Trashed, deletedAt: expect.any(Date) });
      await expect(
        ctx.get(AssetRepository).getMetadataByKey(response.id, AssetMetadataKey.DeletedReimport),
      ).resolves.toEqual(
        expect.objectContaining({ value: { mode: DeletedReimportMode.Trash, reimportedAt: expect.any(String) } }),
      );
      await expect(getRemembered(ctx.database, user.id)).resolves.toEqual([
        expect.objectContaining({
          reimportedAt: expect.any(Date),
          reimportMode: DeletedReimportMode.Trash,
          notifiedAt: null,
        }),
      ]);
      expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AssetTrashAll', {
        assetIds: [response.id],
        userId: user.id,
      });
      expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AssetDeletedReimport', { userId: user.id });
    });

    it('should store an unknown file like any other', async () => {
      const { sut, ctx } = setupAssetMediaService();
      const { user } = await ctx.newUser();
      const file = mediumFactory.uploadFile();

      const response = await sut.uploadAsset(factory.auth({ user: { id: user.id } }), dto, file);

      await expect(
        ctx.database.selectFrom('asset').select(['status']).where('id', '=', response.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: AssetStatus.Active });
      expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalledWith('AssetDeletedReimport', expect.anything());
    });

    it('should not store the upload in skip mode', async () => {
      const { sut, ctx } = setupAssetMediaService();
      const { user } = await ctx.newUser();
      await setPreferences(ctx.database, user.id, DeletedReimportMode.Skip);
      const file = mediumFactory.uploadFile();
      const deletedAssetId = await remember(ctx, user.id, file.checksum);

      await expect(sut.uploadAsset(factory.auth({ user: { id: user.id } }), dto, file)).resolves.toEqual({
        id: deletedAssetId,
        status: AssetMediaStatus.DUPLICATE,
      });

      await expect(
        ctx.database.selectFrom('asset').select('id').where('ownerId', '=', user.id).execute(),
      ).resolves.toEqual([]);
      await expect(getRemembered(ctx.database, user.id)).resolves.toEqual([
        expect.objectContaining({ reimportMode: DeletedReimportMode.Skip, reimportedAt: expect.any(Date) }),
      ]);
    });

    it('should collect the upload in the "Previously deleted" album in album mode', async () => {
      const { sut, ctx } = setupAssetMediaService();
      const { user } = await ctx.newUser();
      await setPreferences(ctx.database, user.id, DeletedReimportMode.Album);
      const auth = factory.auth({ user: { id: user.id } });
      const first = mediumFactory.uploadFile();
      const second = mediumFactory.uploadFile();
      await remember(ctx, user.id, first.checksum);
      await remember(ctx, user.id, second.checksum);

      const firstResponse = await sut.uploadAsset(auth, dto, first);
      const secondResponse = await sut.uploadAsset(auth, dto, second);

      const albums = await ctx.get(AlbumRepository).getAll(user.id, { isOwned: true });
      expect(albums).toEqual([expect.objectContaining({ albumName: DELETED_REIMPORT_ALBUM_NAME })]);
      await expect(
        ctx.get(AlbumRepository).getAssetIds(albums[0].id, [firstResponse.id, secondResponse.id]),
      ).resolves.toEqual(new Set([firstResponse.id, secondResponse.id]));
      const metadata = await ctx.get(UserRepository).getMetadata(user.id);
      expect(metadata).toEqual([
        {
          key: UserMetadataKey.Preferences,
          value: { deletedReimport: { mode: DeletedReimportMode.Album, albumId: albums[0].id } },
        },
      ]);
      await expect(
        ctx.database
          .selectFrom('asset')
          .select(['status'])
          .where('id', '=', firstResponse.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: AssetStatus.Active });
    });

    it('should recreate the album when it was deleted', async () => {
      const { sut, ctx } = setupAssetMediaService();
      const { user } = await ctx.newUser();
      await setPreferences(ctx.database, user.id, DeletedReimportMode.Album);
      const auth = factory.auth({ user: { id: user.id } });
      const first = mediumFactory.uploadFile();
      const second = mediumFactory.uploadFile();
      await remember(ctx, user.id, first.checksum);
      await remember(ctx, user.id, second.checksum);

      await sut.uploadAsset(auth, dto, first);
      const [album] = await ctx.get(AlbumRepository).getAll(user.id, { isOwned: true });
      await ctx.get(AlbumRepository).delete(album.id);
      const secondResponse = await sut.uploadAsset(auth, dto, second);

      const albums = await ctx.get(AlbumRepository).getAll(user.id, { isOwned: true });
      expect(albums).toEqual([expect.objectContaining({ albumName: DELETED_REIMPORT_ALBUM_NAME })]);
      expect(albums[0].id).not.toBe(album.id);
      await expect(ctx.get(AlbumRepository).getAssetIds(albums[0].id, [secondResponse.id])).resolves.toEqual(
        new Set([secondResponse.id]),
      );
    });

    it('should reject remembered files in the bulk upload check only in skip mode', async () => {
      const { sut, ctx } = setupAssetMediaService();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const remembered = mediumFactory.uploadFile();
      const unknown = mediumFactory.uploadFile();
      const deletedAssetId = await remember(ctx, user.id, remembered.checksum);
      const assets = [
        { id: 'remembered', checksum: remembered.checksum.toString('hex') },
        { id: 'unknown', checksum: unknown.checksum.toString('hex') },
      ];

      await expect(sut.bulkUploadCheck(auth, { assets })).resolves.toEqual({
        results: [
          { id: 'remembered', action: AssetUploadAction.ACCEPT },
          { id: 'unknown', action: AssetUploadAction.ACCEPT },
        ],
      });

      await setPreferences(ctx.database, user.id, DeletedReimportMode.Skip);

      await expect(sut.bulkUploadCheck(auth, { assets })).resolves.toEqual({
        results: [
          {
            id: 'remembered',
            action: AssetUploadAction.REJECT,
            reason: AssetRejectReason.DUPLICATE,
            assetId: deletedAssetId,
            isTrashed: false,
          },
          { id: 'unknown', action: AssetUploadAction.ACCEPT },
        ],
      });
    });
  });

  describe(AlbumService.name, () => {
    it('should forget the checksum of an asset removed from the "Previously deleted" album', async () => {
      const { sut, ctx } = setupAlbumService();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: other } = await ctx.newAsset({ ownerId: user.id });
      const { album: otherAlbum } = await ctx.newAlbum({ ownerId: user.id }, [other.id]);
      const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: DELETED_REIMPORT_ALBUM_NAME }, [asset.id]);
      await ctx.get(UserRepository).upsertMetadata(user.id, {
        key: UserMetadataKey.Preferences,
        value: { deletedReimport: { mode: DeletedReimportMode.Album, albumId: album.id } },
      });
      const repository = ctx.get(AssetDeletedChecksumRepository);
      for (const { checksum, id } of [asset, other]) {
        await repository.upsert({ ownerId: user.id, checksum, assetId: id, originalFileName: 'a.jpg' });
      }
      const auth = factory.auth({ user: { id: user.id } });

      await sut.removeAssets(auth, otherAlbum.id, { ids: [other.id] });
      await expect(getRemembered(ctx.database, user.id)).resolves.toHaveLength(2);

      await sut.removeAssets(auth, album.id, { ids: [asset.id] });
      await expect(getRemembered(ctx.database, user.id)).resolves.toEqual([
        expect.objectContaining({ checksum: other.checksum }),
      ]);
    });
  });

  describe(NotificationService.name, () => {
    it('should create one notification for every pending re-upload and none afterwards', async () => {
      const { sut, ctx } = setupNotificationService();
      ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();
      const { user } = await ctx.newUser();
      const repository = ctx.get(AssetDeletedChecksumRepository);
      const checksums = [Buffer.from('one'), Buffer.from('two'), Buffer.from('three')];
      for (const checksum of checksums) {
        await repository.upsert({ ownerId: user.id, checksum, assetId: factory.uuid(), originalFileName: 'a.jpg' });
        await repository.markReimported(user.id, checksum, DeletedReimportMode.Trash);
      }

      await expect(sut.handleDeletedReimport({ userId: user.id })).resolves.toBe(JobStatus.Success);
      await expect(sut.handleDeletedReimport({ userId: user.id })).resolves.toBe(JobStatus.Skipped);

      const notifications = await ctx.get(NotificationRepository).search(user.id, {});
      expect(notifications).toEqual([
        expect.objectContaining({
          type: NotificationType.Custom,
          title: 'Previously deleted files',
          description: '3 previously deleted files were moved to the trash',
          data: JSON.stringify({ deletedReimport: { trash: 3, skip: 0, album: 0, albumId: null } }),
        }),
      ]);
      expect(ctx.getMock(WebsocketRepository).clientSend).toHaveBeenCalledExactlyOnceWith(
        'on_notification',
        user.id,
        expect.objectContaining({ title: 'Previously deleted files' }),
      );
      await expect(getRemembered(ctx.database, user.id)).resolves.toEqual(
        checksums.map(() => expect.objectContaining({ notifiedAt: expect.any(Date) })),
      );
    });
  });
});
