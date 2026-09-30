<script lang="ts">
  import SettingInputField from '$lib/components/shared-components/settings/SettingInputField.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { handleUpdateTagPath } from '$lib/services/tag.service';
  import type { TreeNode } from '$lib/utils/tree-utils';
  import { Field, FormModal, Switch } from '@immich/ui';
  import { mdiTag } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    tag: TreeNode;
    onClose: () => void;
  };

  const { tag, onClose }: Props = $props();

  let tagColor = $state(tag.color ?? '');
  // the full path, so a tag moves by typing another parent (People/Family) and renames by changing the last part
  let tagPath = $state(tag.path ?? '');
  let isHidden = $state(tag.isHidden ?? false);

  const onSubmit = async () => {
    const success = await handleUpdateTagPath(tag, tagPath, { color: tagColor || null, isHidden });
    if (success) {
      onClose();
    }
  };
</script>

<FormModal title={$t('edit_tag')} size="small" icon={mdiTag} {onClose} {onSubmit}>
  <SettingInputField inputType={SettingInputFieldType.COLOR} label={$t('color')} bind:value={tagColor} />
  <SettingInputField
    inputType={SettingInputFieldType.TEXT}
    label={$t('tag_path')}
    description={$t('tag_path_description')}
    bind:value={tagPath}
  />
  <Field label={$t('tag_hidden')} description={$t('tag_hidden_description')} class="mt-4">
    <Switch bind:checked={isHidden} data-testid="tag-hidden" />
  </Field>
</FormModal>
