import { AlbumUserRole, AssetMetadataKey, AssetStatus, DeletedReimportMode, UserMetadataKey } from 'src/enum';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetDeletedChecksumRepository } from 'src/repositories/asset-deleted-checksum.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { getPreferences, getPreferencesPartial } from 'src/utils/preferences';

// The handling of a new file that is the same as a file its owner permanently deleted before. The upload and the
// Google Takeout import both go through it, so every mode of the owner's deletedReimport preference behaves the same.

/** The name of the album re-uploads of previously deleted files are collected in (DeletedReimportMode.Album) */
export const DELETED_REIMPORT_ALBUM_NAME = 'Previously deleted';

export type DeletedReimportRepositories = {
  album: AlbumRepository;
  asset: AssetRepository;
  assetDeletedChecksum: AssetDeletedChecksumRepository;
  event: EventRepository;
  user: UserRepository;
};

export type DeletedReimport = {
  userId: string;
  checksum: Buffer;
  mode: DeletedReimportMode;
  /** The file is not stored: the caller drops it and answers with the asset it belonged to (skip mode) */
  skip: boolean;
  /** The asset the file belonged to before its permanent deletion */
  assetId: string;
  originalFileName: string;
};

/**
 * How a new file of the owner is handled when they permanently deleted the same file before, following their
 * preference; undefined when they did not. Pass the result to onDeletedReimport: right away when the file is skipped,
 * else with the new asset once it is stored.
 */
export const checkDeletedReimport = async (
  repos: DeletedReimportRepositories,
  { userId, checksum }: { userId: string; checksum: Buffer },
): Promise<DeletedReimport | undefined> => {
  const remembered = await repos.assetDeletedChecksum.get(userId, checksum);
  if (!remembered) {
    return;
  }

  const { mode } = getPreferences(await repos.user.getMetadata(userId)).deletedReimport;
  return {
    userId,
    checksum,
    mode,
    skip: mode === DeletedReimportMode.Skip,
    assetId: remembered.assetId,
    originalFileName: remembered.originalFileName,
  };
};

/**
 * Move the new asset of a previously deleted file to the trash or collect it in the "Previously deleted" album, as
 * checkDeletedReimport decided (no asset when the file is skipped), then record the re-upload and tell the owner (the
 * notification job coalesces the events of a batch into one notification)
 */
export const onDeletedReimport = async (
  repos: DeletedReimportRepositories,
  { userId, checksum, mode }: DeletedReimport,
  asset?: { id: string; checksum: Buffer },
) => {
  if (asset) {
    await repos.asset.upsertMetadata(asset.id, [
      { key: AssetMetadataKey.DeletedReimport, value: { mode, reimportedAt: new Date().toISOString() } },
    ]);

    if (mode === DeletedReimportMode.Trash) {
      await repos.asset.updateAll([asset.id], { deletedAt: new Date(), status: AssetStatus.Trashed });
      await repos.event.emit('AssetTrashAll', { assetIds: [asset.id], userId });
    }

    if (mode === DeletedReimportMode.Album) {
      const albumId = await getDeletedReimportAlbum(repos, userId);
      await repos.album.addAssetIds(albumId, [asset.id]);
      await repos.event.emit('AlbumUpdate', { id: albumId, userIds: [userId], recipientIds: [] });
    }
  }

  await repos.assetDeletedChecksum.markReimported(userId, asset ? asset.checksum : checksum, mode);
  await repos.event.emit('AssetDeletedReimport', { userId });
};

/** The owner's "Previously deleted" album, created when it does not exist (yet or anymore) */
const getDeletedReimportAlbum = async (repos: DeletedReimportRepositories, userId: string) => {
  const preferences = getPreferences(await repos.user.getMetadata(userId));
  if (preferences.deletedReimport.albumId) {
    const album = await repos.album.getById(preferences.deletedReimport.albumId, { withAssets: false });
    const isOwner = album?.albumUsers.some(({ user, role }) => user.id === userId && role === AlbumUserRole.Owner);
    if (album && isOwner) {
      return album.id;
    }
  }

  const album = await repos.album.create(
    {
      albumName: DELETED_REIMPORT_ALBUM_NAME,
      description: 'Files that were uploaded again after they had been permanently deleted',
      order: preferences.albums.defaultAssetOrder,
    },
    [],
    [{ userId, role: AlbumUserRole.Owner }],
    userId,
  );

  preferences.deletedReimport.albumId = album.id;
  await repos.user.upsertMetadata(userId, {
    key: UserMetadataKey.Preferences,
    value: getPreferencesPartial(preferences),
  });

  return album.id;
};
