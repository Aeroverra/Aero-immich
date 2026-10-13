<script lang="ts">
  import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
  import { viewManager } from '$lib/managers/view-manager.svelte';
  import CustomViewEditModal from '$lib/modals/CustomViewEditModal.svelte';
  import PrivateModePinModal from '$lib/modals/PrivateModePinModal.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    deleteCustomView,
    getCustomViews,
    updateCustomView,
    ViewAccess,
    type CustomViewResponseDto,
  } from '@immich/sdk';
  import { Button, Icon, IconButton, modalManager, Text, toastManager } from '@immich/ui';
  import {
    mdiArrowDown,
    mdiArrowUp,
    mdiLockOutline,
    mdiPencilOutline,
    mdiShieldLockOutline,
    mdiStar,
    mdiStarOutline,
    mdiTrashCanOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  let views = $state<CustomViewResponseDto[]>([]);

  const load = async () => {
    if (!privateModeManager.enabled) {
      views = [];
      return;
    }
    try {
      views = await getCustomViews({});
    } catch (error) {
      handleError(error, $t('errors.unable_to_load_custom_views'));
    }
  };

  // views name hidden tags, so they are listed and edited only while private mode is unlocked
  $effect(() => {
    if (privateModeManager.enabled) {
      void load();
    } else {
      views = [];
    }
  });

  const afterChange = async () => {
    await load();
    await viewManager.load();
    privateModeManager.invalidate();
  };

  const handleUnlock = () => modalManager.show(PrivateModePinModal, {});

  const handleCreate = async () => {
    const saved = await modalManager.show(CustomViewEditModal, {});
    if (saved) {
      toastManager.primary($t('custom_view_saved', { values: { name: saved.name } }));
      await afterChange();
    }
  };

  const handleEdit = async (view: CustomViewResponseDto) => {
    const saved = await modalManager.show(CustomViewEditModal, { view });
    if (saved) {
      toastManager.primary($t('custom_view_saved', { values: { name: saved.name } }));
      await afterChange();
    }
  };

  const handleSetDefault = async (view: CustomViewResponseDto) => {
    if (view.access !== ViewAccess.Open) {
      toastManager.warning($t('custom_view_default_needs_open_access'));
      return;
    }
    try {
      await updateCustomView({ id: view.id, customViewUpdateDto: { isDefault: !view.isDefault } });
      await afterChange();
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_custom_view'));
    }
  };

  const handleDelete = async (view: CustomViewResponseDto) => {
    const isConfirmed = await modalManager.showDialog({
      title: $t('custom_view_delete'),
      prompt: $t('custom_view_delete_confirmation', { values: { name: view.name } }),
      confirmText: $t('delete'),
    });
    if (!isConfirmed) {
      return;
    }
    try {
      await deleteCustomView({ id: view.id });
      await afterChange();
    } catch (error) {
      handleError(error, $t('errors.unable_to_delete_custom_view'));
    }
  };

  const handleMove = async (index: number, offset: number) => {
    const reordered = [...views];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(index + offset, 0, moved);
    try {
      for (const [order, view] of reordered.entries()) {
        if (view.order !== order) {
          await updateCustomView({ id: view.id, customViewUpdateDto: { order } });
        }
      }
      await afterChange();
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_custom_view'));
    }
  };

  const describe = (view: CustomViewResponseDto) => {
    const parts = [];
    if (view.includeAll) {
      parts.push($t('custom_view_summary_everything'));
    } else {
      if (view.includeUntagged) {
        parts.push($t('custom_view_summary_untagged'));
      }
      if (view.includeTagIds.length > 0) {
        parts.push($t('custom_view_summary_tags', { values: { count: view.includeTagIds.length } }));
      }
    }
    if (view.excludeTagIds.length > 0) {
      parts.push($t('custom_view_summary_excluded', { values: { count: view.excludeTagIds.length } }));
    }
    return parts.join(', ');
  };
</script>

<section class="my-4">
  <div in:fade={{ duration: 500 }} class="flex flex-col gap-4 sm:ms-8" data-testid="views-settings">
    <Text size="small" color="muted">{$t('custom_views_settings_description')}</Text>

    {#if privateModeManager.enabled}
      {#if views.length === 0}
        <Text size="small">{$t('custom_views_empty')}</Text>
      {:else}
        <ul class="flex flex-col gap-2">
          {#each views as view, index (view.id)}
            <li
              class="flex flex-wrap items-center gap-x-2 rounded-xl border border-gray-200 px-4 py-2 dark:border-gray-700"
              data-testid="view-row"
            >
              <div class="flex min-w-0 grow basis-full flex-col sm:basis-0">
                <div class="flex items-center gap-2">
                  <span class="truncate font-medium">{view.name}</span>
                  {#if view.access === ViewAccess.Locked}
                    <Icon icon={mdiLockOutline} size="16" aria-label={$t('custom_view_access_locked')} />
                  {:else if view.access === ViewAccess.Private}
                    <Icon icon={mdiShieldLockOutline} size="16" aria-label={$t('custom_view_access_private')} />
                  {/if}
                  {#if view.isDefault}
                    <span class="text-xs text-primary">{$t('custom_view_default')}</span>
                  {/if}
                </div>
                <Text size="tiny" color="muted" class="truncate">{describe(view)}</Text>
              </div>
              <div class="ms-auto flex items-center">
                <IconButton
                  shape="round"
                  variant="ghost"
                  color="secondary"
                  size="small"
                  icon={mdiArrowUp}
                  aria-label={$t('move_up')}
                  disabled={index === 0}
                  onclick={() => handleMove(index, -1)}
                />
                <IconButton
                  shape="round"
                  variant="ghost"
                  color="secondary"
                  size="small"
                  icon={mdiArrowDown}
                  aria-label={$t('move_down')}
                  disabled={index === views.length - 1}
                  onclick={() => handleMove(index, 1)}
                />
                <IconButton
                  shape="round"
                  variant="ghost"
                  color={view.isDefault ? 'primary' : 'secondary'}
                  size="small"
                  icon={view.isDefault ? mdiStar : mdiStarOutline}
                  aria-label={view.isDefault ? $t('custom_view_unset_default') : $t('custom_view_set_default')}
                  title={view.isDefault ? $t('custom_view_unset_default') : $t('custom_view_set_default')}
                  onclick={() => handleSetDefault(view)}
                />
                <IconButton
                  shape="round"
                  variant="ghost"
                  color="secondary"
                  size="small"
                  icon={mdiPencilOutline}
                  aria-label={$t('custom_view_edit')}
                  onclick={() => handleEdit(view)}
                />
                <IconButton
                  shape="round"
                  variant="ghost"
                  color="danger"
                  size="small"
                  icon={mdiTrashCanOutline}
                  aria-label={$t('custom_view_delete')}
                  onclick={() => handleDelete(view)}
                />
              </div>
            </li>
          {/each}
        </ul>
      {/if}

      <div class="flex justify-end">
        <Button shape="round" size="small" onclick={() => handleCreate()} data-testid="view-create">
          {$t('custom_view_create')}
        </Button>
      </div>
    {:else}
      <div class="flex items-center justify-between gap-4">
        <Text size="small">{$t('custom_views_require_private_mode')}</Text>
        <Button shape="round" size="small" leadingIcon={mdiLockOutline} onclick={() => handleUnlock()}>
          {$t('private_mode_enable')}
        </Button>
      </div>
    {/if}
  </div>
</section>
