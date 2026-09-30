<script lang="ts">
  import ViewTagPicker from '$lib/components/user-settings-page/ViewTagPicker.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    createCustomView,
    getAllTags,
    updateCustomView,
    ViewAccess,
    ViewPrivateAssets,
    type CustomViewResponseDto,
    type TagResponseDto,
  } from '@immich/sdk';
  import { Field, FormModal, Input, Select, Switch, Text } from '@immich/ui';
  import { mdiFilterVariant } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    view?: CustomViewResponseDto;
    onClose: (saved?: CustomViewResponseDto) => void;
  }

  let { view, onClose }: Props = $props();

  let name = $state(view?.name ?? '');
  let access = $state(view?.access ?? ViewAccess.Open);
  let includeAll = $state(view?.includeAll ?? false);
  let includeUntagged = $state(view?.includeUntagged ?? false);
  let includeTagIds = $state<string[]>(view?.includeTagIds ?? []);
  let excludeTagIds = $state<string[]>(view?.excludeTagIds ?? []);
  let privateAssets = $state(view?.privateAssets ?? ViewPrivateAssets.Unlocked);
  let tags = $state<TagResponseDto[]>([]);

  const isDefault = $derived(!!view?.isDefault);
  const disabled = $derived(name.trim() === '' || (!includeAll && !includeUntagged && includeTagIds.length === 0));

  onMount(async () => {
    try {
      tags = await getAllTags();
    } catch (error) {
      handleError(error, $t('errors.unable_to_load_tags'));
    }
  });

  const onSubmit = async () => {
    const dto = {
      name: name.trim(),
      access: isDefault ? ViewAccess.Open : access,
      includeAll,
      includeUntagged: includeAll ? false : includeUntagged,
      includeTagIds: includeAll ? [] : includeTagIds,
      excludeTagIds,
      privateAssets,
    };

    try {
      const saved = view
        ? await updateCustomView({ id: view.id, customViewUpdateDto: dto })
        : await createCustomView({ customViewCreateDto: dto });
      onClose(saved);
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_custom_view'));
    }
  };
</script>

<FormModal
  title={view ? $t('custom_view_edit') : $t('custom_view_create')}
  icon={mdiFilterVariant}
  {onClose}
  {onSubmit}
  {disabled}
  submitText={view ? $t('save') : $t('create')}
  size="medium"
>
  <div class="flex flex-col gap-4" data-testid="view-editor">
    <Field label={$t('name')}>
      <Input bind:value={name} data-testid="view-name" />
    </Field>

    <Field
      label={$t('custom_view_access')}
      description={isDefault ? $t('custom_view_access_default_description') : $t('custom_view_access_description')}
      disabled={isDefault}
    >
      <Select
        options={[
          { label: $t('custom_view_access_open'), value: ViewAccess.Open },
          { label: $t('custom_view_access_locked'), value: ViewAccess.Locked },
          { label: $t('custom_view_access_private'), value: ViewAccess.Private },
        ]}
        bind:value={access}
      />
    </Field>

    <Field label={$t('custom_view_include_all')} description={$t('custom_view_include_all_description')}>
      <Switch bind:checked={includeAll} data-testid="view-include-all" />
    </Field>

    {#if !includeAll}
      <Field label={$t('custom_view_include_untagged')} description={$t('custom_view_include_untagged_description')}>
        <Switch bind:checked={includeUntagged} />
      </Field>

      <ViewTagPicker
        label={$t('custom_view_include_tags')}
        {tags}
        bind:selectedIds={includeTagIds}
        excludedIds={excludeTagIds}
        testId="view-include-tags"
      />
    {/if}

    <ViewTagPicker
      label={$t('custom_view_exclude_tags')}
      {tags}
      bind:selectedIds={excludeTagIds}
      excludedIds={includeTagIds}
      testId="view-exclude-tags"
    />
    <Text size="tiny" color="muted">{$t('custom_view_exclude_tags_description')}</Text>

    <Field label={$t('custom_view_private_assets')}>
      <Select
        options={[
          { label: $t('custom_view_private_assets_hide'), value: ViewPrivateAssets.Hide },
          { label: $t('custom_view_private_assets_unlocked'), value: ViewPrivateAssets.Unlocked },
          { label: $t('custom_view_private_assets_only'), value: ViewPrivateAssets.Only },
        ]}
        bind:value={privateAssets}
      />
    </Field>
  </div>
</FormModal>
