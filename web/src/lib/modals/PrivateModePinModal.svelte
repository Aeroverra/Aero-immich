<script lang="ts">
  import PinCodeCreateForm from '$lib/components/user-settings-page/PinCodeCreateForm.svelte';
  import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { getAuthStatus } from '@immich/sdk';
  import { Icon, LoadingSpinner, Modal, ModalBody, PinInput } from '@immich/ui';
  import { mdiLockOpenVariantOutline, mdiLockOutline, mdiLockSmart } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  interface Props {
    onClose: (enabled?: boolean) => void;
    /** the same PIN also unlocks other things, such as switching to a locked view */
    title?: string;
    description?: string;
    onPinCode?: (pinCode: string) => Promise<void>;
  }

  let { onClose, title, description, onPinCode }: Props = $props();

  let pinCode = $state('');
  let isVerified = $state(false);
  let isBadPinCode = $state(false);
  // undefined until the server has answered, so the create form is never shown on a stale cached value
  let hasPinCode = $state<boolean>();
  let pinInputContainer = $state<HTMLElement>();

  // the autofocus attribute is ignored for inputs added after the page loaded, so focus the PIN field once it renders
  $effect(() => {
    const input = pinInputContainer?.querySelector('input');
    if (input) {
      requestAnimationFrame(() => input.focus());
    }
  });

  onMount(async () => {
    try {
      const status = await getAuthStatus();
      hasPinCode = status.pinCode;
    } catch (error) {
      handleError(error, $t('errors.unable_to_load_private_mode'));
      onClose();
    }
  });

  const handleEnable = async (code: string) => {
    try {
      await (onPinCode ? onPinCode(code) : privateModeManager.enable(code));
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

<Modal title={title ?? $t('private_mode')} icon={mdiLockOutline} onClose={() => onClose()} size="small">
  <ModalBody>
    <div class="flex flex-col items-center justify-center gap-6 py-2">
      {#if hasPinCode === undefined}
        <LoadingSpinner />
      {:else if hasPinCode}
        {#if isVerified}
          <div in:fade={{ duration: 200 }}>
            <Icon icon={mdiLockOpenVariantOutline} size="64" class="text-success/90" />
          </div>
        {:else}
          <div class:text-danger={isBadPinCode} class:text-primary={!isBadPinCode}>
            <Icon icon={mdiLockOutline} size="64" />
          </div>
        {/if}

        <p class="text-center text-sm" style="text-wrap: pretty;">
          {description ?? $t('private_mode_enable_description')}
        </p>

        <div bind:this={pinInputContainer}>
          <PinInput password autofocus bind:value={pinCode} onComplete={handleEnable} />
        </div>
      {:else}
        <div class="text-primary">
          <Icon icon={mdiLockSmart} size="64" />
        </div>
        <p class="mb-4 text-center text-sm" style="text-wrap: pretty;">
          {$t('private_mode_create_pin_code_description')}
        </p>
        <PinCodeCreateForm showLabel={false} onCreated={(code) => handleEnable(code)} />
      {/if}
    </div>
  </ModalBody>
</Modal>
