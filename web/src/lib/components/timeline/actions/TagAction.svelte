<script lang="ts">
  import { shortcut } from '$lib/actions/shortcut';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { pinnedTagsBar } from '$lib/components/tags/tag-picker.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import AssetTagModal from '$lib/modals/AssetTagModal.svelte';
  import { resolveStackSelection } from '$lib/services/stack-selection.service';
  import { IconButton, modalManager } from '@immich/ui';
  import { mdiTagMultipleOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    menuItem?: boolean;
  }

  let { menuItem = false }: Props = $props();

  const text = $t('tag');
  const icon = mdiTagMultipleOutline;

  // the selection bar offers the pinned tags while the page offers tagging the selection
  onMount(() => {
    pinnedTagsBar.hosts++;
    return () => {
      pinnedTagsBar.hosts--;
    };
  });

  const handleTagAssets = async () => {
    const assetIds = await resolveStackSelection(assetMultiSelectManager.ownedAssets);
    if (!assetIds) {
      return;
    }

    const didUpdate = await modalManager.show(AssetTagModal, { assetIds });
    if (didUpdate) {
      assetMultiSelectManager.clear();
    }
  };
</script>

<svelte:document use:shortcut={{ shortcut: { key: 't' }, onShortcut: handleTagAssets }} />

{#if menuItem}
  <MenuOption {text} {icon} onClick={handleTagAssets} />
{/if}

{#if !menuItem}
  <IconButton shape="round" color="secondary" variant="ghost" aria-label={text} {icon} onclick={handleTagAssets} />
{/if}
