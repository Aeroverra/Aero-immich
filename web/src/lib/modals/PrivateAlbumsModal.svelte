<script lang="ts">
  import type { PrivateAlbumsChoice } from '$lib/services/private-mode.service';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { Checkbox, ConfirmModal, Icon, Label } from '@immich/ui';
  import { mdiLockOutline, mdiShareVariantOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    albums: AlbumResponseDto[];
    onClose: (choice?: PrivateAlbumsChoice) => void;
  };

  let { albums, onClose: onCloseParent }: Props = $props();

  let removeFromAlbums = $state(false);

  const onClose = (confirmed: boolean) => {
    if (!confirmed) {
      onCloseParent();
      return;
    }
    onCloseParent(removeFromAlbums ? 'remove' : 'keep');
  };
</script>

<ConfirmModal
  title={$t('mark_private_albums_title')}
  confirmText={$t('mark_private_keep_albums')}
  icon={mdiLockOutline}
  confirmColor="primary"
  {onClose}
>
  {#snippet prompt()}
    <p>{$t('mark_private_albums_description', { values: { count: albums.length } })}</p>

    <ul class="mx-auto my-4 flex max-w-xs flex-col gap-1 text-start">
      {#each albums as album (album.id)}
        <li class="flex items-center gap-2 rounded-lg bg-subtle px-3 py-2">
          <span class="truncate font-medium">{album.albumName}</span>
          {#if album.shared || album.hasSharedLink}
            <span class="ms-auto flex shrink-0 items-center gap-1 text-xs text-fg-muted" title={$t('shared')}>
              <Icon icon={mdiShareVariantOutline} size="16" aria-hidden />
              {$t('shared')}
            </span>
          {/if}
        </li>
      {/each}
    </ul>

    <div class="flex items-center justify-center gap-2 pt-2">
      <Checkbox id="private-albums-remove-input" bind:checked={removeFromAlbums} color="secondary" />
      <Label label={$t('mark_private_remove_from_albums')} for="private-albums-remove-input" />
    </div>
  {/snippet}
</ConfirmModal>
