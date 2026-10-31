<script lang="ts">
  import ApiKeyPermissionsPicker from '$lib/components/ApiKeyPermissionsPicker.svelte';
  import ApiKeySecretModal from '$lib/modals/ApiKeySecretModal.svelte';
  import { handleCreateApiKey } from '$lib/services/api-key.service';
  import { toApiKeyPermissions } from '$lib/utils/api-key-permissions';
  import { Permission } from '@immich/sdk';
  import { Field, FormModal, Input, modalManager } from '@immich/ui';
  import { mdiKeyVariant } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = { onClose: () => void };

  const { onClose }: Props = $props();

  let name = $state('API Key');
  let selectedPermissions = $state<Permission[]>([]);

  const onSubmit = async () => {
    const permissions = toApiKeyPermissions(selectedPermissions);
    const response = await handleCreateApiKey({ name, permissions });
    if (response) {
      await modalManager.show(ApiKeySecretModal, { secret: response.secret });
      onClose();
    }
  };
</script>

<FormModal title={$t('new_api_key')} icon={mdiKeyVariant} {onClose} {onSubmit} submitText={$t('create')} size="giant">
  <div class="mb-4 flex flex-col gap-2">
    <Field label={$t('name')}>
      <Input bind:value={name} />
    </Field>
  </div>
  <ApiKeyPermissionsPicker bind:selectedPermissions />
</FormModal>
