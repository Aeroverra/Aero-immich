<script lang="ts">
  import type { PrivateAlbumsChoice } from '$lib/services/private-mode.service';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { Button, Icon, Modal, ModalBody, ModalFooter, Text } from '@immich/ui';
  import { mdiShareVariantOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    albums: AlbumResponseDto[];
    onClose: (choice?: PrivateAlbumsChoice) => void;
  };

  let { albums, onClose }: Props = $props();
</script>

<Modal title={$t('mark_private_albums_title')} {onClose} size="small">
  <ModalBody>
    <Text>{$t('mark_private_albums_description', { values: { count: albums.length } })}</Text>
    <ul class="my-4 flex flex-col gap-2">
      {#each albums as album (album.id)}
        <li class="flex items-center gap-2">
          <Text fontWeight="semi-bold">{album.albumName}</Text>
          {#if album.shared || album.hasSharedLink}
            <span class="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
              <Icon icon={mdiShareVariantOutline} size="18" aria-hidden />
              {$t('shared')}
            </span>
          {/if}
        </li>
      {/each}
    </ul>
    <Text size="small">{$t('mark_private_remove_from_albums_description')}</Text>
  </ModalBody>
  <ModalFooter>
    <div class="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
      <Button shape="round" color="secondary" variant="ghost" onclick={() => onClose()}>{$t('cancel')}</Button>
      <Button shape="round" color="secondary" onclick={() => onClose('remove')}>
        {$t('mark_private_remove_from_albums')}
      </Button>
      <Button shape="round" color="primary" onclick={() => onClose('keep')}>{$t('mark_private_keep_albums')}</Button>
    </div>
  </ModalFooter>
</Modal>
