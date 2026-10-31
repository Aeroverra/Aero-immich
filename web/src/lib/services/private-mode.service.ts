import { getAlbumsForAssets, removeAssetFromAlbum, type AlbumForAssetsResponseDto } from '@immich/sdk';
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

  let albums: AlbumForAssetsResponseDto[];
  try {
    // one request for the whole selection, each album comes with the selected assets it holds
    const found = await getAlbumsForAssets({ albumsForAssetsDto: { assetIds } });
    albums = found.filter(({ album }) => !album.isPrivate);
  } catch (error) {
    handleError(error, $t('error_loading_albums'));
    return false;
  }

  if (albums.length === 0) {
    return true;
  }

  const choice = await modalManager.show(PrivateAlbumsModal, {
    albums: albums.map(({ album }) => album),
  });
  if (!choice) {
    return false;
  }

  if (choice === 'remove') {
    try {
      for (const { album, assetIds: ids } of albums) {
        await removeAssetFromAlbum({ id: album.id, bulkIdsDto: { ids } });
      }
    } catch (error) {
      handleError(error, $t('errors.error_removing_assets_from_album'));
      return false;
    }
  }

  return true;
};
