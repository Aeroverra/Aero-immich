<script lang="ts">
  import { ViewAccess, type CustomViewResponseDto } from '@immich/sdk';
  import { Button, Icon, Modal, ModalBody, ModalFooter } from '@immich/ui';
  import { mdiChevronRight, mdiEyeOffOutline, mdiEyeOutline, mdiLockOutline, mdiShieldLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    views: CustomViewResponseDto[];
    /** offer switching back to all photos (the user has no default view) */
    allPhotos: boolean;
    currentViewName: string;
    onClose: (choice?: { view: CustomViewResponseDto | null }) => void;
  };

  let { views, allPhotos, currentViewName, onClose }: Props = $props();

  const accessIcon = (view: CustomViewResponseDto) => {
    if (view.access === ViewAccess.Locked) {
      return mdiLockOutline;
    }
    if (view.access === ViewAccess.Private) {
      return mdiShieldLockOutline;
    }
    return mdiEyeOutline;
  };

  const subtitle = (view: CustomViewResponseDto) => {
    if (view.isDefault) {
      return $t('custom_view_default');
    }
    if (view.access === ViewAccess.Locked) {
      return $t('custom_view_access_locked');
    }
    if (view.access === ViewAccess.Private) {
      return $t('custom_view_access_private');
    }
  };
</script>

{#snippet option(view: CustomViewResponseDto | null, name: string, icon: string, description?: string)}
  <button
    type="button"
    class="flex w-full items-center gap-3 rounded-xl bg-subtle px-4 py-3 text-start transition-colors hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-primary"
    onclick={() => onClose({ view })}
  >
    <Icon {icon} size="20" class="shrink-0 text-primary" aria-hidden />
    <span class="flex min-w-0 flex-col">
      <span class="truncate font-medium">{name}</span>
      {#if description}
        <span class="text-xs text-muted">{description}</span>
      {/if}
    </span>
    <Icon icon={mdiChevronRight} size="20" class="ms-auto shrink-0 text-muted" aria-hidden />
  </button>
{/snippet}

<Modal title={$t('hidden_asset_title')} icon={mdiEyeOffOutline} onClose={() => onClose()} size="small">
  <ModalBody>
    <p class="text-sm" style="text-wrap: pretty;">
      {$t('hidden_asset_views_description', { values: { name: currentViewName } })}
    </p>

    <ul class="mt-4 flex flex-col gap-2" data-testid="hidden-asset-views">
      {#if allPhotos}
        <li>{@render option(null, $t('custom_view_all_photos'), mdiEyeOutline)}</li>
      {/if}
      {#each views as view (view.id)}
        <li>{@render option(view, view.name, accessIcon(view), subtitle(view))}</li>
      {/each}
    </ul>
  </ModalBody>
  <ModalFooter>
    <Button shape="round" color="secondary" fullWidth onclick={() => onClose()}>{$t('cancel')}</Button>
  </ModalFooter>
</Modal>
