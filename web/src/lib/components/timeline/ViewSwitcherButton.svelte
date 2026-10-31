<script lang="ts">
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { viewManager } from '$lib/managers/view-manager.svelte';
  import PrivateModePinModal from '$lib/modals/PrivateModePinModal.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { ViewAccess, type CustomViewResponseDto } from '@immich/sdk';
  import { modalManager } from '@immich/ui';
  import { mdiCheck, mdiEyeOutline, mdiFilterVariant, mdiLockOutline, mdiShieldLockOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  onMount(() => void viewManager.load());

  const activeView = $derived(viewManager.active.view);
  const activeName = $derived(activeView?.name ?? $t('custom_view_all_photos'));
  const isFiltered = $derived(!!viewManager.active.viewId);

  const accessIcon = (view: CustomViewResponseDto) => {
    if (view.access === ViewAccess.Locked) {
      return mdiLockOutline;
    }
    if (view.access === ViewAccess.Private) {
      return mdiShieldLockOutline;
    }
    return mdiEyeOutline;
  };

  const handleSwitch = async (view: CustomViewResponseDto | null) => {
    const viewId = view && !view.isDefault ? view.id : null;
    if (viewId === (viewManager.active.viewId ?? null)) {
      return;
    }

    if (view && viewId && view.access === ViewAccess.Locked) {
      // the PIN is asked on every switch to a locked view
      await modalManager.show(PrivateModePinModal, {
        title: $t('custom_view_switch_locked_title', { values: { name: view.name } }),
        description: $t('custom_view_switch_locked_description'),
        onPinCode: (pinCode: string) => viewManager.switch(viewId, pinCode),
      });
      return;
    }

    try {
      await viewManager.switch(viewId);
    } catch (error) {
      handleError(error, $t('errors.unable_to_switch_custom_view'));
    }
  };
</script>

{#if featureFlagsManager.value.customViews && viewManager.views.length > 0}
  <div class="flex items-center" data-testid="view-switcher">
    <span
      class="hidden max-w-40 truncate text-sm font-medium lg:inline {isFiltered ? 'text-primary' : ''}"
      data-testid="view-switcher-name">{activeName}</span
    >
    <ButtonContextMenu
      icon={mdiFilterVariant}
      title={$t('custom_view_switcher_title', { values: { name: activeName } })}
      color={isFiltered ? 'primary' : 'secondary'}
      size="medium"
      align="bottom-right"
      direction="left"
      hideContent
      buttonClass="max-sm:size-8"
    >
      <MenuOption
        text={viewManager.defaultView?.name ?? $t('custom_view_all_photos')}
        subtitle={$t('custom_view_default')}
        icon={isFiltered ? mdiEyeOutline : mdiCheck}
        onClick={() => handleSwitch(viewManager.defaultView ?? null)}
      />
      {#each viewManager.otherViews as view (view.id)}
        <MenuOption
          text={view.name}
          subtitle={view.access === ViewAccess.Locked
            ? $t('custom_view_access_locked')
            : view.access === ViewAccess.Private
              ? $t('custom_view_access_private')
              : undefined}
          icon={viewManager.active.viewId === view.id ? mdiCheck : accessIcon(view)}
          onClick={() => handleSwitch(view)}
        />
      {/each}
    </ButtonContextMenu>
  </div>
{/if}
