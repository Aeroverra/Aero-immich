<script lang="ts">
  import ApiKeyPermissionsPicker from '$lib/components/ApiKeyPermissionsPicker.svelte';
  import { handleUpdateApiKey } from '$lib/services/api-key.service';
  import { fromApiKeyPermissions, toApiKeyPermissions } from '$lib/utils/api-key-permissions';
  import { Permission } from '@immich/sdk';
  import { Field, FormModal, Input } from '@immich/ui';
  import { mdiKeyVariant } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    apiKey: { id: string; name: string; permissions: Permission[] };
    onClose: () => void;
  };

  let { apiKey, onClose }: Props = $props();

  let name = $state(apiKey.name);
  let selectedPermissions = $state<Permission[]>(fromApiKeyPermissions(apiKey.permissions));

  const onSubmit = async () => {
    const success = await handleUpdateApiKey(apiKey, {
      name,
      permissions: toApiKeyPermissions(selectedPermissions),
    });
    if (success) {
      onClose();
    }
  };
</script>

<FormModal title={$t('api_key')} icon={mdiKeyVariant} {onClose} {onSubmit} size="giant">
  <div class="mb-4 flex flex-col gap-2">
    <Field label={$t('name')}>
      <Input bind:value={name} />
    </Field>
  </div>
  <ApiKeyPermissionsPicker bind:selectedPermissions />
</FormModal>
