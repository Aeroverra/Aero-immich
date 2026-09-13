<script lang="ts">
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
  import { handleMarkPrivateAlbums } from '$lib/services/private-mode.service';
  import type { OnSetPrivate } from '$lib/utils/actions';
  import { handleError } from '$lib/utils/handle-error';
  import { updateAssets } from '@immich/sdk';
  import { IconButton, toastManager } from '@immich/ui';
  import { mdiLockOpenVariantOutline, mdiLockOutline, mdiTimerSand } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    /** called with the assets that stay visible after the change (mode on, or unmarking) */
    onSetPrivate?: OnSetPrivate;
    /** called with the assets that disappear from the view (marked while the mode is off) */
    onRemove?: (ids: string[]) => void;
  }

  let { onSetPrivate, onRemove }: Props = $props();

  let loading = $state(false);

  const handleSetPrivate = async (isPrivate: boolean) => {
    const assets = assetMultiSelectManager.getOwnedAssets().filter((asset) => asset.isPrivate !== isPrivate);
    const ids = assets.map(({ id }) => id);

    // the albums holding these assets turn private with them, the user decides what happens to them first
    if (isPrivate && ids.length > 0 && !(await handleMarkPrivateAlbums(ids))) {
      return;
    }

    loading = true;

    try {
      if (ids.length > 0) {
        await updateAssets({ assetBulkUpdateDto: { ids, isPrivate } });
      }

      for (const asset of assets) {
        asset.isPrivate = isPrivate;
      }

      // private assets are only visible while the mode is on, so marking with the mode off hides them
      if (isPrivate && !privateModeManager.enabled) {
        onRemove?.(ids);
      } else {
        onSetPrivate?.(ids, isPrivate);
      }

      toastManager.primary(
        isPrivate
          ? $t('marked_private', { values: { count: ids.length } })
          : $t('unmarked_private', { values: { count: ids.length } }),
      );

      assetMultiSelectManager.clear();
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_private', { values: { private: isPrivate } }));
    } finally {
      loading = false;
    }
  };
</script>

{#if loading}
  <IconButton
    shape="round"
    color="secondary"
    variant="ghost"
    aria-label={$t('loading')}
    icon={mdiTimerSand}
    onclick={() => {}}
  />
{:else}
  <!-- both can show at once for a mixed selection; unmarking only makes sense while private assets are visible -->
  {#if assetMultiSelectManager.hasNonPrivate}
    <IconButton
      shape="round"
      color="secondary"
      variant="ghost"
      aria-label={$t('mark_private')}
      icon={mdiLockOutline}
      onclick={() => handleSetPrivate(true)}
    />
  {/if}
  {#if privateModeManager.enabled && assetMultiSelectManager.hasPrivate}
    <IconButton
      shape="round"
      color="secondary"
      variant="ghost"
      aria-label={$t('unmark_private')}
      icon={mdiLockOpenVariantOutline}
      onclick={() => handleSetPrivate(false)}
    />
  {/if}
{/if}
