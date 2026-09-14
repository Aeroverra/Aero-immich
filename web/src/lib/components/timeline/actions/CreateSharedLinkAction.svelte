<script lang="ts">
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import SharedLinkCreateModal from '$lib/modals/SharedLinkCreateModal.svelte';
  import { resolveStackSelection } from '$lib/services/stack-selection.service';
  import { IconButton, modalManager } from '@immich/ui';
  import { mdiShareVariantOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  const handleClick = async () => {
    const assets = assetMultiSelectManager.assets;
    const assetIds = await resolveStackSelection(assets);
    if (!assetIds) {
      return;
    }

    await modalManager.show(SharedLinkCreateModal, {
      assetIds,
      hasPrivate: assets.some((asset) => asset.isPrivate),
    });
  };
</script>

<IconButton
  shape="round"
  color="secondary"
  variant="ghost"
  aria-label={$t('share')}
  icon={mdiShareVariantOutline}
  onclick={handleClick}
/>
