<script lang="ts">
  import TagGroups from '$lib/components/tags/TagGroups.svelte';
  import TagTreePicker from '$lib/components/tags/TagTreePicker.svelte';
  import { rememberRecentTags } from '$lib/components/tags/tag-picker.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { tagAssets } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAllTags, upsertTags, type TagResponseDto } from '@immich/sdk';
  import { FormModal } from '@immich/ui';
  import { mdiTag } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { SvelteSet } from 'svelte/reactivity';

  interface Props {
    onClose: (updated?: boolean) => void;
    assetIds: string[];
  }

  let { onClose, assetIds }: Props = $props();

  let allTags: TagResponseDto[] = $state([]);
  let selectedIds = new SvelteSet<string>();
  let disabled = $derived(selectedIds.size === 0);
  const selectedTags = $derived(allTags.filter(({ id }) => selectedIds.has(id)));

  onMount(async () => {
    allTags = await getAllTags();
  });

  const onSubmit = async () => {
    if (selectedIds.size === 0) {
      return;
    }

    const updatedIds = await tagAssets({ tagIds: [...selectedIds], assetIds, showNotification: false });
    rememberRecentTags([...selectedIds]);
    eventManager.emit('AssetsTag', updatedIds);
    onClose(true);
  };

  const onToggle = (tag: TagResponseDto, checked: boolean) => {
    if (checked) {
      selectedIds.add(tag.id);
    } else {
      selectedIds.delete(tag.id);
    }
  };

  const onCreate = async (path: string) => {
    try {
      const [tag] = await upsertTags({ tagUpsertDto: { tags: [path] } });
      // the parents the new path needed are new too
      allTags = await getAllTags();
      eventManager.emit('TagCreate', tag);
      selectedIds.add(tag.id);
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  };
</script>

<FormModal
  size="small"
  title={$t('tag_assets')}
  icon={mdiTag}
  {onClose}
  {onSubmit}
  submitText={$t('tag_assets')}
  onOpenAutoFocus={(event) => event.preventDefault()}
  {disabled}
>
  <div class="my-4 flex flex-col gap-4">
    <TagTreePicker
      tags={allTags}
      checkedIds={selectedIds}
      {onToggle}
      {onCreate}
      autofocus
      listClass="max-h-[50vh] overflow-y-auto immich-scrollbar"
    />

    {#if selectedTags.length > 0}
      <TagGroups tags={selectedTags} onRemove={(tag) => selectedIds.delete(tag.id)} />
    {/if}
  </div>
</FormModal>
