<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import AssetPeopleModal from '$lib/modals/AssetPeopleModal.svelte';
  import { resolveStackSelection } from '$lib/services/stack-selection.service';
  import { modalManager } from '@immich/ui';
  import { mdiAccountMultipleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  const isAvailable = $derived(
    authManager.preferences.people.enabled && assetMultiSelectManager.ownedAssets.length > 0,
  );

  const handleEditPeople = async () => {
    const assetIds = await resolveStackSelection(assetMultiSelectManager.ownedAssets);
    if (!assetIds) {
      return;
    }

    const didUpdate = await modalManager.show(AssetPeopleModal, { assetIds });
    if (didUpdate) {
      assetMultiSelectManager.clear();
    }
  };
</script>

{#if isAvailable}
  <MenuOption text={$t('people_edit_assets')} icon={mdiAccountMultipleOutline} onClick={handleEditPeople} />
{/if}
