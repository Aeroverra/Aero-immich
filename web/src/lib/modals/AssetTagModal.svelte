<script lang="ts">
  import TagGroups from '$lib/components/tags/TagGroups.svelte';
  import TagTreePicker from '$lib/components/tags/TagTreePicker.svelte';
  import { rememberRecentTags } from '$lib/components/tags/tag-picker.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { removeTag, tagAssets } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAllTags, getTagAssetCounts, upsertTags, type TagResponseDto } from '@immich/sdk';
  import { FormModal, Text } from '@immich/ui';
  import { mdiTag } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { SvelteMap } from 'svelte/reactivity';

  interface Props {
    onClose: (updated?: boolean) => void;
    assetIds: string[];
  }

  let { onClose, assetIds }: Props = $props();

  let allTags: TagResponseDto[] = $state([]);
  // how many of the assets carry each tag, so the tree shows which tags all, some or none of them have
  let counts = $state<Record<string, number>>({});
  // the tags to add to every asset (true) or to take off every asset (false)
  const changes = new SvelteMap<string, boolean>();

  const isChecked = (tagId: string) => changes.get(tagId) ?? (counts[tagId] ?? 0) === assetIds.length;
  const checkedIds = $derived(new Set(allTags.filter(({ id }) => isChecked(id)).map(({ id }) => id)));
  const partialIds = $derived(
    new Set(
      allTags
        .filter(({ id }) => !changes.has(id) && (counts[id] ?? 0) > 0 && (counts[id] ?? 0) < assetIds.length)
        .map(({ id }) => id),
    ),
  );
  const added = $derived(allTags.filter(({ id }) => changes.get(id) === true));
  const removed = $derived(allTags.filter(({ id }) => changes.get(id) === false));

  onMount(async () => {
    try {
      const [tags, tagCounts] = await Promise.all([
        getAllTags(),
        getTagAssetCounts({ tagAssetCountsDto: { assetIds } }),
      ]);
      counts = Object.fromEntries(tagCounts.map(({ tagId, count }) => [tagId, count]));
      allTags = tags;
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  });

  const onToggle = (tag: TagResponseDto, checked: boolean) => {
    const count = counts[tag.id] ?? 0;
    const unchanged = (checked && count === assetIds.length) || (!checked && count === 0);
    if (unchanged) {
      changes.delete(tag.id);
    } else {
      changes.set(tag.id, checked);
    }
  };

  const onCreate = async (path: string) => {
    try {
      const [tag] = await upsertTags({ tagUpsertDto: { tags: [path] } });
      // the parents the new path needed are new too
      allTags = await getAllTags();
      eventManager.emit('TagCreate', tag);
      changes.set(tag.id, true);
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  };

  const onSubmit = async () => {
    if (changes.size === 0) {
      return;
    }

    try {
      const addIds = added.map(({ id }) => id);
      const removeIds = removed.map(({ id }) => id);
      if (addIds.length > 0) {
        await tagAssets({ tagIds: addIds, assetIds });
        rememberRecentTags(addIds);
      }
      if (removeIds.length > 0) {
        await removeTag({ tagIds: removeIds, assetIds });
      }
      eventManager.emit('AssetsTag', assetIds);
      onClose(true);
    } catch (error) {
      handleError(error, $t('errors.failed_to_tag_assets'));
    }
  };
</script>

<FormModal
  size="small"
  title={$t('tag_assets')}
  icon={mdiTag}
  {onClose}
  {onSubmit}
  submitText={$t('save')}
  onOpenAutoFocus={(event) => event.preventDefault()}
  disabled={changes.size === 0}
>
  <div class="my-4 flex flex-col gap-4">
    {#if assetIds.length > 1}
      <Text size="small" color="muted"
        >{$t('tag_assets_selection_description', { values: { count: assetIds.length } })}</Text
      >
    {/if}

    <TagTreePicker
      tags={allTags}
      {checkedIds}
      {partialIds}
      {onToggle}
      {onCreate}
      autofocus
      listClass="max-h-[50vh] overflow-y-auto immich-scrollbar"
    />

    {#if added.length > 0}
      <div class="flex flex-col gap-1" data-testid="tag-changes-add">
        <Text size="small">{$t('tag_changes_add')}</Text>
        <TagGroups tags={added} onRemove={(tag) => changes.delete(tag.id)} />
      </div>
    {/if}
    {#if removed.length > 0}
      <div class="flex flex-col gap-1" data-testid="tag-changes-remove">
        <Text size="small">{$t('tag_changes_remove')}</Text>
        <TagGroups tags={removed} onRemove={(tag) => changes.delete(tag.id)} />
      </div>
    {/if}
  </div>
</FormModal>
