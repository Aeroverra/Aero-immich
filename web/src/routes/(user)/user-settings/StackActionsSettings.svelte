<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { StackActionMode, updateMyPreferences } from '@immich/sdk';
  import { Button, Field, Select, toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  let mode = $state(authManager.preferences.stackActions?.mode ?? StackActionMode.Ask);

  const handleSave = async () => {
    try {
      const response = await updateMyPreferences({ userPreferencesUpdateDto: { stackActions: { mode } } });
      authManager.setPreferences(response);
      toastManager.primary($t('saved_settings'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_settings'));
    }
  };

  const onsubmit = (event: Event) => {
    event.preventDefault();
  };
</script>

<section class="my-4">
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" {onsubmit}>
      <div class="flex flex-col gap-4 sm:ms-8">
        <Field label={$t('stack_actions_mode')} description={$t('stack_actions_mode_description')}>
          <Select
            options={[
              { label: $t('stack_actions_mode_ask'), value: StackActionMode.Ask },
              { label: $t('stack_actions_mode_primary'), value: StackActionMode.Primary },
              { label: $t('stack_actions_mode_stack'), value: StackActionMode.Stack },
            ]}
            bind:value={mode}
          />
        </Field>

        <div class="flex justify-end">
          <Button shape="round" type="submit" size="small" onclick={() => handleSave()}>{$t('save')}</Button>
        </div>
      </div>
    </form>
  </div>
</section>
