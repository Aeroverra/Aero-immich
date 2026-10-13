<script lang="ts">
  import { fade } from 'svelte/transition';

  import SettingButtonsRow from '$lib/components/shared-components/settings/SystemConfigButtonRow.svelte';
  import SettingInputField from '$lib/components/shared-components/settings/SettingInputField.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { t } from 'svelte-i18n';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const config = $derived(systemConfigManager.value);
  let configToEdit = $state(systemConfigManager.cloneValue());
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <div class="ms-4 mt-4 flex flex-col gap-4">
        <SettingInputField
          inputType={SettingInputFieldType.NUMBER}
          min={1}
          max={4}
          label={$t('admin.takeout_readers')}
          description={$t('admin.takeout_readers_description')}
          bind:value={configToEdit.takeout.readers}
          required={true}
          {disabled}
          isEdited={configToEdit.takeout.readers !== config.takeout.readers}
        />

        <SettingInputField
          inputType={SettingInputFieldType.NUMBER}
          min={0}
          label={$t('admin.takeout_throttle')}
          description={$t('admin.takeout_throttle_description')}
          bind:value={configToEdit.takeout.throttleMBps}
          required={false}
          {disabled}
          isEdited={configToEdit.takeout.throttleMBps !== config.takeout.throttleMBps}
        />

        <SettingInputField
          inputType={SettingInputFieldType.NUMBER}
          min={1}
          max={8}
          label={$t('admin.takeout_readahead')}
          description={$t('admin.takeout_readahead_description')}
          bind:value={configToEdit.takeout.readaheadDepth}
          required={true}
          {disabled}
          isEdited={configToEdit.takeout.readaheadDepth !== config.takeout.readaheadDepth}
        />

        <SettingButtonsRow bind:configToEdit keys={['takeout']} {disabled} />
      </div>
    </form>
  </div>
</div>
