<script lang="ts">
  import ApiKeyGrid from '$lib/components/user-settings-page/UserApiKeyGrid.svelte';
  import { isAllStandardPermissions, standardPermissions } from '$lib/utils/api-key-permissions';
  import { Permission } from '@immich/sdk';
  import { Checkbox, IconButton, Input, Label } from '@immich/ui';
  import { mdiClose } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    selectedPermissions: Permission[];
  };

  let { selectedPermissions = $bindable([]) }: Props = $props();

  // privateMode.access is listed like every other permission, only "select all" leaves it out
  const permissions: Record<string, Permission[]> = {};
  for (const permission of Object.values(Permission)) {
    if (permission === Permission.All) {
      continue;
    }

    const [group] = permission.split('.', 1);
    if (!Object.hasOwn(permissions, group)) {
      permissions[group] = [];
    }
    permissions[group].push(permission);
  }

  let searchValue = $state('');
  let allItemsSelected = $derived(isAllStandardPermissions(selectedPermissions));

  const matchFilter = (search: string) => {
    search = search.toLowerCase();

    return ([title, items]: [string, Permission[]]) =>
      title.toLowerCase().includes(search) || items.some((item) => item.toLowerCase().includes(search));
  };

  // select all never touches privateMode.access, it is granted on its own
  const onCheckedAllChange = (checked: boolean) => {
    const keep = selectedPermissions.includes(Permission.PrivateModeAccess) ? [Permission.PrivateModeAccess] : [];
    selectedPermissions = checked ? [...standardPermissions, ...keep] : keep;
  };

  const filteredResults = $derived(Object.entries(permissions).filter(matchFilter(searchValue)));

  const handleSelectItems = (items: Permission[]) =>
    (selectedPermissions = Array.from(new Set([...selectedPermissions, ...items])));

  const handleDeselectItems = (items: Permission[]) =>
    (selectedPermissions = selectedPermissions.filter((item) => !items.includes(item)));
</script>

<Label label={$t('permission')} for="permission-container" />
<div class="m-4 flex items-center gap-2" id="permission-container">
  <Checkbox id="input-select-all" size="tiny" checked={allItemsSelected} onCheckedChange={onCheckedAllChange} />
  <Label label={$t('select_all')} for="input-select-all" />
</div>

<div class="ms-4 flex flex-col gap-2">
  <Input bind:value={searchValue} placeholder={$t('search')}>
    {#snippet trailingIcon()}
      {#if searchValue}
        <IconButton
          icon={mdiClose}
          size="small"
          variant="ghost"
          shape="round"
          color="secondary"
          class="me-1"
          onclick={() => (searchValue = '')}
          aria-label={$t('clear')}
        />
      {/if}
    {/snippet}
  </Input>
  {#each filteredResults as [title, subItems] (title)}
    <ApiKeyGrid
      {title}
      {subItems}
      description={title === 'privateMode' ? $t('api_key_private_mode_access_description') : undefined}
      selectedItems={selectedPermissions}
      {handleSelectItems}
      {handleDeselectItems}
    />
  {/each}
</div>
