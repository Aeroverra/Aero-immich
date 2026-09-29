<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import AssetTagPeopleModal from '$lib/modals/AssetTagPeopleModal.svelte';
  import { resolveStackSelection } from '$lib/services/stack-selection.service';
  import { modalManager } from '@immich/ui';
  import { mdiAccountPlusOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  // videos have no face boxes to draw, so people are tagged on them from the selection
  const isAvailable = $derived(
    authManager.preferences.people.enabled && assetMultiSelectManager.ownedAssets.some((asset) => asset.isVideo),
  );

  const handleTagPeople = async () => {
    const assetIds = await resolveStackSelection(assetMultiSelectManager.ownedAssets);
    if (!assetIds) {
      return;
    }

    const didUpdate = await modalManager.show(AssetTagPeopleModal, { assetIds });
    if (didUpdate) {
      assetMultiSelectManager.clear();
    }
  };
</script>

{#if isAvailable}
  <MenuOption text={$t('tag_people_in_videos')} icon={mdiAccountPlusOutline} onClick={handleTagPeople} />
{/if}
