<script lang="ts">
  import Combobox, { type ComboBoxOption } from '$lib/components/shared-components/Combobox.svelte';
  import TagPill from '$lib/components/shared-components/TagPill.svelte';
  import type { TagResponseDto } from '@immich/sdk';
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props {
    label: string;
    tags: TagResponseDto[];
    selectedIds: string[];
    /** tags picked in the other list, which cannot be picked here */
    excludedIds?: string[];
    testId?: string;
  }

  let { label, tags, selectedIds = $bindable(), excludedIds = [], testId }: Props = $props();

  const tagMap = $derived(Object.fromEntries(tags.map((tag) => [tag.id, tag])));
  const options = $derived(
    tags
      .filter((tag) => !selectedIds.includes(tag.id) && !excludedIds.includes(tag.id))
      .map((tag) => ({ id: tag.id, label: tag.value, value: tag.id })),
  );

  const handleSelect = (option?: ComboBoxOption) => {
    if (!option || selectedIds.includes(option.value)) {
      return;
    }
    selectedIds = [...selectedIds, option.value];
  };

  const handleRemove = (tagId: string) => {
    selectedIds = selectedIds.filter((id) => id !== tagId);
  };
</script>

<div class="flex flex-col gap-1" data-testid={testId}>
  <Combobox onSelect={handleSelect} {label} {options} placeholder={$t('search_tags')} />
  <Text size="tiny" color="muted">{$t('custom_view_tags_include_children')}</Text>
  {#if selectedIds.length > 0}
    <section class="flex flex-wrap gap-1 pt-1">
      {#each selectedIds as tagId (tagId)}
        <TagPill label={tagMap[tagId]?.value ?? tagId} onRemove={() => handleRemove(tagId)} />
      {/each}
    </section>
  {/if}
</div>
