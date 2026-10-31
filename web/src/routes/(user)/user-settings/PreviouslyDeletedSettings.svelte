<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    DeletedReimportMode,
    deleteMyDeletedChecksums,
    getMyDeletedChecksumStatistics,
    updateMyPreferences,
  } from '@immich/sdk';
  import { Button, Field, modalManager, Select, Text, toastManager } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  let mode = $state(authManager.preferences.deletedReimport?.mode ?? DeletedReimportMode.Trash);
  let count = $state<number>();

  const loadStatistics = async () => {
    try {
      const statistics = await getMyDeletedChecksumStatistics();
      count = statistics.count;
    } catch (error) {
      handleError(error, $t('errors.unable_to_load_previously_deleted_files'));
    }
  };

  const handleSave = async () => {
    try {
      const response = await updateMyPreferences({ userPreferencesUpdateDto: { deletedReimport: { mode } } });
      authManager.setPreferences(response);
      toastManager.primary($t('saved_settings'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_settings'));
    }
  };

  const handleForgetAll = async () => {
    const isConfirmed = await modalManager.showDialog({
      prompt: $t('previously_deleted_forget_all_confirmation', { values: { count: count ?? 0 } }),
    });
    if (!isConfirmed) {
      return;
    }

    try {
      await deleteMyDeletedChecksums();
      count = 0;
      toastManager.primary($t('previously_deleted_forgotten'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_forget_previously_deleted_files'));
    }
  };

  const onsubmit = (event: Event) => {
    event.preventDefault();
  };

  onMount(() => loadStatistics());
</script>

<section class="my-4">
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" {onsubmit}>
      <div class="flex flex-col gap-4 sm:ms-8">
        <Field label={$t('previously_deleted_mode')} description={$t('previously_deleted_mode_description')}>
          <Select
            options={[
              { label: $t('previously_deleted_mode_trash'), value: DeletedReimportMode.Trash },
              { label: $t('previously_deleted_mode_skip'), value: DeletedReimportMode.Skip },
              { label: $t('previously_deleted_mode_album'), value: DeletedReimportMode.Album },
            ]}
            bind:value={mode}
          />
        </Field>

        <div class="flex flex-col gap-2">
          <Text size="small" color="muted">
            {$t('previously_deleted_remembered_files', { values: { count: count ?? 0 } })}
          </Text>
          <div>
            <Button
              shape="round"
              size="small"
              color="danger"
              variant="ghost"
              disabled={!count}
              onclick={() => handleForgetAll()}
            >
              {$t('previously_deleted_forget_all', { values: { count: count ?? 0 } })}
            </Button>
          </div>
        </div>

        <div class="flex justify-end">
          <Button shape="round" type="submit" size="small" onclick={() => handleSave()}>{$t('save')}</Button>
        </div>
      </div>
    </form>
  </div>
</section>
