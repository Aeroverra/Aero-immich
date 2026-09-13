<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
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
    /** render as context menu entries: "mark" when the selection has non-private assets, "unmark" when it has private ones */
    menuItem?: boolean;
    /** icon button only: toggle direction */
    unmark?: boolean;
  }

  let { onSetPrivate, onRemove, menuItem = false, unmark = false }: Props = $props();

  let text = $derived(unmark ? $t('unmark_private') : $t('mark_private'));
  let icon = $derived(unmark ? mdiLockOpenVariantOutline : mdiLockOutline);

  let loading = $state(false);

  const handleSetPrivate = async (isPrivate: boolean) => {
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

{#if menuItem}
  {#if assetMultiSelectManager.hasNonPrivate}
    <MenuOption text={$t('mark_private')} icon={mdiLockOutline} onClick={() => handleSetPrivate(true)} />
  {/if}
  {#if privateModeManager.enabled && assetMultiSelectManager.hasPrivate}
    <MenuOption text={$t('unmark_private')} icon={mdiLockOpenVariantOutline} onClick={() => handleSetPrivate(false)} />
  {/if}
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
    <IconButton
      shape="round"
      color="secondary"
      variant="ghost"
      aria-label={text}
      {icon}
      onclick={() => handleSetPrivate(!unmark)}
    />
  {/if}
{/if}
