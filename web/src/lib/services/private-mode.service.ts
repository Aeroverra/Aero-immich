import { getAllAlbums, removeAssetFromAlbum, type AlbumResponseDto } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import PrivateAlbumsModal from '$lib/modals/PrivateAlbumsModal.svelte';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

export type PrivateAlbumsChoice = 'keep' | 'remove';

/**
 * Marking assets private also makes every non-private album they appear in private, which hides those albums
 * while the mode is off. Lists them and lets the user keep them as they are, pull the selected assets out of them
 * first (so the albums stay visible), or cancel. Resolves to true when marking may go ahead.
 */
export const handleMarkPrivateAlbums = async (assetIds: string[]) => {
  const $t = await getFormatter();

  const albums = new Map<string, { album: AlbumResponseDto; assetIds: string[] }>();
  try {
    for (const assetId of assetIds) {
      for (const album of await getAllAlbums({ assetId })) {
        if (album.isPrivate) {
          continue;
        }
        const entry = albums.get(album.id) ?? { album, assetIds: [] };
        entry.assetIds.push(assetId);
        albums.set(album.id, entry);
      }
    }
  } catch (error) {
    handleError(error, $t('error_loading_albums'));
    return false;
  }

  if (albums.size === 0) {
    return true;
  }

  const choice = await modalManager.show(PrivateAlbumsModal, {
    albums: [...albums.values()].map(({ album }) => album),
  });
  if (!choice) {
    return false;
  }

  if (choice === 'remove') {
    try {
      for (const { album, assetIds: ids } of albums.values()) {
        await removeAssetFromAlbum({ id: album.id, bulkIdsDto: { ids } });
      }
    } catch (error) {
      handleError(error, $t('errors.error_removing_assets_from_album'));
      return false;
    }
  }

  return true;
};
