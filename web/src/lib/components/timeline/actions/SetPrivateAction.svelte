<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import type { OnSetPrivate } from '$lib/utils/actions';
  import { handleError } from '$lib/utils/handle-error';
  import { updateAssets } from '@immich/sdk';
  import { IconButton, toastManager } from '@immich/ui';
  import { mdiLockOpenVariantOutline, mdiLockOutline, mdiTimerSand } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    onSetPrivate?: OnSetPrivate;
    menuItem?: boolean;
    unmark?: boolean;
  }

  let { onSetPrivate, menuItem = false, unmark = false }: Props = $props();

  let text = $derived(unmark ? $t('unmark_private') : $t('mark_private'));
  let icon = $derived(unmark ? mdiLockOpenVariantOutline : mdiLockOutline);

  let loading = $state(false);

  const handleSetPrivate = async () => {
    const isPrivate = !unmark;
    loading = true;

    try {
      const assets = assetMultiSelectManager.getOwnedAssets().filter((asset) => asset.isPrivate !== isPrivate);

      const ids = assets.map(({ id }) => id);

      if (ids.length > 0) {
        await updateAssets({ assetBulkUpdateDto: { ids, isPrivate } });
      }

      for (const asset of assets) {
        asset.isPrivate = isPrivate;
      }

      onSetPrivate?.(ids, isPrivate);

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

{#if menuItem}
  <MenuOption {text} {icon} onClick={handleSetPrivate} />
{/if}

{#if !menuItem}
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
    <IconButton shape="round" color="secondary" variant="ghost" aria-label={text} {icon} onclick={handleSetPrivate} />
  {/if}
{/if}
