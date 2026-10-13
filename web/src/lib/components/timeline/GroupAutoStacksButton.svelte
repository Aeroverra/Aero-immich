<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { isGroupingAutoStacks } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { updateMyPreferences } from '@immich/sdk';
  import { IconButton } from '@immich/ui';
  import { mdiCameraBurst, mdiImageMultipleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  const isGrouped = $derived(isGroupingAutoStacks());
  let isSaving = $state(false);

  const handleToggle = async () => {
    isSaving = true;
    try {
      const preferences = await updateMyPreferences({
        userPreferencesUpdateDto: { stacks: { groupAuto: !isGrouped } },
      });
      authManager.setPreferences(preferences);
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_settings'));
    } finally {
      isSaving = false;
    }
  };
</script>

{#if featureFlagsManager.value.stackSource}
  <IconButton
    shape="round"
    color={isGrouped ? 'primary' : 'secondary'}
    variant="ghost"
    size="medium"
    icon={isGrouped ? mdiCameraBurst : mdiImageMultipleOutline}
    onclick={handleToggle}
    disabled={isSaving}
    title={isGrouped ? $t('show_automatic_stacks_as_separate_photos') : $t('group_automatic_stacks')}
    aria-label={$t('group_automatic_stacks')}
    aria-pressed={isGrouped}
    data-testid="group-auto-stacks-toggle"
  />
{/if}
