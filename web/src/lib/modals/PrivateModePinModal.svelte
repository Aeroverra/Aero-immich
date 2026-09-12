<script lang="ts">
  import PinCodeCreateForm from '$lib/components/user-settings-page/PinCodeCreateForm.svelte';
  import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { Icon, Modal, ModalBody, PinInput } from '@immich/ui';
  import { mdiLockOpenVariantOutline, mdiLockOutline, mdiLockSmart } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  interface Props {
    onClose: (enabled?: boolean) => void;
  }

  let { onClose }: Props = $props();

  let pinCode = $state('');
  let isVerified = $state(false);
  let isBadPinCode = $state(false);

  const handleEnable = async (code: string) => {
    try {
      await privateModeManager.enable(code);
      isVerified = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
      onClose(true);
    } catch (error) {
      handleError(error, $t('wrong_pin_code'));
      isBadPinCode = true;
      pinCode = '';
    }
  };
</script>

<Modal title={$t('private_mode')} icon={mdiLockOutline} onClose={() => onClose()} size="small">
  <ModalBody>
    <div class="flex flex-col items-center justify-center gap-6 py-2">
      {#if privateModeManager.hasPinCode}
        {#if isVerified}
          <div in:fade={{ duration: 200 }}>
            <Icon icon={mdiLockOpenVariantOutline} size="64" class="text-success/90" />
          </div>
        {:else}
          <div class:text-danger={isBadPinCode} class:text-primary={!isBadPinCode}>
            <Icon icon={mdiLockOutline} size="64" />
          </div>
        {/if}

        <p class="text-center text-sm" style="text-wrap: pretty;">{$t('private_mode_enable_description')}</p>

        <PinInput password autofocus bind:value={pinCode} onComplete={handleEnable} />
      {:else}
        <div class="text-primary">
          <Icon icon={mdiLockSmart} size="64" />
        </div>
        <p class="mb-4 text-center text-sm" style="text-wrap: pretty;">
          {$t('new_pin_code_subtitle')}
        </p>
        <PinCodeCreateForm showLabel={false} onCreated={(code) => handleEnable(code)} />
      {/if}
    </div>
  </ModalBody>
</Modal>
