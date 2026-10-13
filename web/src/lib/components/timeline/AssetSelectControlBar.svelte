<script lang="ts">
  import ControlAppBar from '$lib/components/shared-components/ControlAppBar.svelte';
  import PinnedTagsBar from '$lib/components/tags/PinnedTagsBar.svelte';
  import { pinnedTagsBar } from '$lib/components/tags/tag-picker.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { mdiClose } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    children?: Snippet;
  };

  let { children }: Props = $props();

  const onClose = () => assetMultiSelectManager.clear();

  const assets = $derived(assetMultiSelectManager.assets);
</script>

<ControlAppBar {onClose} backIcon={mdiClose}>
  {#snippet leading()}
    <div class="font-medium text-primary">
      <p class="block sm:hidden">{assets.length}</p>
      <p class="hidden sm:block">{$t('selected_count', { values: { count: assets.length } })}</p>
    </div>
  {/snippet}
  {#if pinnedTagsBar.hosts > 0}
    <PinnedTagsBar />
  {/if}
  {#snippet trailing()}
    {@render children?.()}
  {/snippet}
</ControlAppBar>
