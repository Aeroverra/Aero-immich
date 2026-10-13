<script lang="ts">
  import AlbumPickerModal from '$lib/modals/AlbumPickerModal.svelte';
  import { addAssetsToAlbums } from '$lib/services/album.service';
  import { type AlbumResponseDto } from '@immich/sdk';

  type Props = {
    assetIds: string[];
    /** whether any of the assets is private, so adding them to a shared album asks for confirmation */
    hasPrivate?: boolean;
    onClose: () => void;
  };

  const { assetIds, hasPrivate = false, onClose }: Props = $props();

  const handleClose = async (albums?: AlbumResponseDto[]) => {
    const albumIds = (albums ?? []).map(({ id }) => id);
    if (albumIds.length === 0) {
      onClose();
      return;
    }

    const success = await addAssetsToAlbums(albumIds, assetIds, { notify: true, hasPrivate, albums });
    if (success) {
      onClose();
    }
  };
</script>

<AlbumPickerModal selectedItemsCount={assetIds.length} onClose={handleClose} />
