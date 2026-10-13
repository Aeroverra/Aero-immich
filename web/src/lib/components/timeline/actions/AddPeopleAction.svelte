<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import AssetAddPeopleModal from '$lib/modals/AssetAddPeopleModal.svelte';
  import { resolveStackSelection } from '$lib/services/stack-selection.service';
  import { modalManager } from '@immich/ui';
  import { mdiAccountPlusOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  // videos have no face boxes to draw, so people are added to them from the selection
  const isAvailable = $derived(
    authManager.preferences.people.enabled && assetMultiSelectManager.ownedAssets.some((asset) => asset.isVideo),
  );

  const handleAddPeople = async () => {
    const assetIds = await resolveStackSelection(assetMultiSelectManager.ownedAssets);
    if (!assetIds) {
      return;
    }

    const didUpdate = await modalManager.show(AssetAddPeopleModal, { assetIds });
    if (didUpdate) {
      assetMultiSelectManager.clear();
    }
  };
</script>

{#if isAvailable}
  <MenuOption text={$t('add_people_to_videos')} icon={mdiAccountPlusOutline} onClick={handleAddPeople} />
{/if}
