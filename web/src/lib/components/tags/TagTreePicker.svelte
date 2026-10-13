<script lang="ts">
  import { tagPicker, tagPickerFocus, tagPickerSearch, togglePinned } from '$lib/components/tags/tag-picker.svelte';
  import { parseTagPath } from '$lib/services/tag.service';
  import { buildTagRows, pickTagRow, tagName } from '$lib/utils/tag-tree';
  import type { TagResponseDto } from '@immich/sdk';
  import { Checkbox, Icon, IconButton } from '@immich/ui';
  import {
    mdiChevronDown,
    mdiChevronRight,
    mdiClose,
    mdiMagnify,
    mdiPin,
    mdiPinOutline,
    mdiPlus,
    mdiUnfoldLessHorizontal,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    tags: TagResponseDto[];
    checkedIds: ReadonlySet<string>;
    /** tags only some of the assets carry, shown with a dash until they are checked or unchecked */
    partialIds?: ReadonlySet<string>;
    onToggle: (tag: TagResponseDto, checked: boolean) => void;
    /** creates the tag [path] (with the parents it needs) and checks it */
    onCreate: (path: string) => void | Promise<void>;
    /** focus the search field when the picker opens */
    autofocus?: boolean;
    /** classes of the tree, such as a maximum height in a dialog */
    listClass?: string;
    /** keep the search when the picker closes, for the detail panel that opens again on the next asset */
    rememberSearch?: boolean;
  };

  let {
    tags,
    checkedIds,
    partialIds = new Set<string>(),
    onToggle,
    onCreate,
    autofocus = false,
    listClass = '',
    rememberSearch = false,
  }: Props = $props();

  const uid = $props.id();
  let query = $state(rememberSearch ? tagPickerSearch.query : '');
  $effect(() => {
    if (rememberSearch) {
      tagPickerSearch.query = query;
    }
  });
  let input = $state<HTMLInputElement>();

  const expanded = $derived(new Set(tagPicker.expanded.current));
  const pinnedIds = $derived(new Set(tagPicker.pinned.current));
  const rows = $derived(buildTagRows(tags, { expanded, checked: checkedIds, query }));
  const recentTags = $derived.by(() => {
    const byId = new Map(tags.map((tag) => [tag.id, tag]));
    return tagPicker.recent.current.map((id) => byId.get(id)).filter((tag) => tag !== undefined);
  });
  const newPath = $derived(parseTagPath(query).join('/'));
  const canCreate = $derived(newPath !== '' && tags.every((tag) => tag.value.toLowerCase() !== newPath.toLowerCase()));

  const toggleExpanded = (tagId: string) => {
    const current = tagPicker.expanded.current;
    tagPicker.expanded.current = current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId];
  };

  const create = async () => {
    const path = newPath;
    query = '';
    await onCreate(path);
  };

  const onkeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && query.trim()) {
      // Enter without a search submits the dialog around the picker, if there is one
      event.preventDefault();
      const row = pickTagRow(rows, query);
      if (row) {
        query = '';
        if (!checkedIds.has(row.tag.id)) {
          onToggle(row.tag, true);
        }
      } else if (canCreate) {
        void create();
      }
    } else if (event.key === 'Escape') {
      // Escape leaves the field, keeping the search, so the viewer keys (arrows, Escape to close) work again
      event.preventDefault();
      event.stopPropagation();
      input?.blur();
    }
  };

  onMount(() => {
    if (autofocus) {
      input?.focus();
    }
  });

  // the tag shortcut of the viewer asks for the search field, also while the picker is already open
  $effect(() => {
    if (Date.now() - tagPickerFocus.requestedAt < 1000) {
      input?.focus();
    }
  });
</script>

<div class="flex flex-col gap-2" data-testid="tag-tree-picker">
  <div class="relative">
    <div class="pointer-events-none absolute inset-y-0 inset-s-0 flex items-center ps-2 text-gray-500">
      <Icon icon={mdiMagnify} size="18" />
    </div>
    <!-- type text, not search: the viewer shortcuts ignore keys typed in text fields -->
    <input
      bind:this={input}
      bind:value={query}
      type="text"
      class="immich-form-input w-full ps-8! pe-8! text-sm"
      placeholder={$t('search_or_create_tags')}
      aria-label={$t('search_or_create_tags')}
      autocomplete="off"
      {onkeydown}
    />
    {#if query}
      <div class="absolute inset-y-0 inset-e-0 flex items-center pe-1">
        <IconButton
          icon={mdiClose}
          size="small"
          variant="ghost"
          shape="round"
          color="secondary"
          aria-label={$t('clear')}
          onclick={() => (query = '')}
        />
      </div>
    {/if}
  </div>

  {#if !query && recentTags.length > 0}
    <div class="flex flex-wrap items-center gap-1" data-testid="tag-picker-recent">
      <span class="me-1 text-xs text-gray-500 dark:text-gray-400">{$t('recent')}</span>
      {#each recentTags as tag (tag.id)}
        {@const checked = checkedIds.has(tag.id)}
        <button
          type="button"
          class="rounded-full border px-2 py-0.5 text-xs transition-colors {checked
            ? 'border-primary bg-primary text-light'
            : 'border-gray-300 hover:border-primary hover:text-primary dark:border-gray-600'}"
          title={tag.value}
          aria-pressed={checked}
          onclick={() => onToggle(tag, !checked)}
        >
          {tagName(tag.value)}
        </button>
      {/each}
    </div>
  {/if}

  <div class={listClass}>
    {#if !query && expanded.size > 0}
      <div class="flex justify-end">
        <button
          type="button"
          class="flex items-center gap-1 text-xs text-gray-500 hover:text-primary dark:text-gray-400"
          onclick={() => (tagPicker.expanded.current = [])}
        >
          <Icon icon={mdiUnfoldLessHorizontal} size="16" />
          {$t('collapse_all')}
        </button>
      </div>
    {/if}

    <ul role="tree" aria-label={$t('tags')} aria-multiselectable="true" class="flex flex-col">
      {#each rows as row (row.tag.id)}
        {@const checked = checkedIds.has(row.tag.id)}
        {@const checkboxId = `${uid}-${row.tag.id}`}
        {@const pinned = pinnedIds.has(row.tag.id)}
        {@const pinLabel = $t(pinned ? 'tag_unpin' : 'tag_pin', { values: { tag: row.tag.value } })}
        <li
          role="treeitem"
          aria-level={row.depth + 1}
          aria-expanded={row.hasChildren ? row.isOpen : undefined}
          aria-selected={checked}
          data-partial={partialIds.has(row.tag.id) ? '' : undefined}
          class="group flex min-h-8 items-center gap-1 rounded-lg pe-1 hover:bg-gray-100 dark:hover:bg-gray-800"
          style:padding-inline-start="{row.depth * 16}px"
          data-testid="tag-picker-row"
          data-tag-value={row.tag.value}
        >
          {#if row.hasChildren && !query}
            <button
              type="button"
              class="flex size-6 shrink-0 items-center justify-center rounded-sm text-gray-500 hover:text-primary"
              aria-label={row.isOpen ? $t('collapse') : $t('expand')}
              onclick={() => toggleExpanded(row.tag.id)}
            >
              <Icon icon={row.isOpen ? mdiChevronDown : mdiChevronRight} size="20" />
            </button>
          {:else}
            <span class="size-6 shrink-0"></span>
          {/if}
          <Checkbox
            id={checkboxId}
            size="tiny"
            {checked}
            indeterminate={!checked && partialIds.has(row.tag.id)}
            onCheckedChange={(value) => onToggle(row.tag, value)}
          />
          <label
            for={checkboxId}
            class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1 ps-1 text-sm {row.isMatch
              ? ''
              : 'text-gray-500 dark:text-gray-400'}"
            title={row.tag.value}
          >
            {#if row.tag.color}
              <span class="size-2 shrink-0 rounded-full" style:background-color={row.tag.color}></span>
            {/if}
            <span class="truncate">{row.name}</span>
          </label>
          {#if row.checkedBelow > 0 && !row.isOpen}
            <span
              class="shrink-0 rounded-full bg-primary/15 px-1.5 text-xs text-primary"
              title={$t('tag_picker_checked_below', { values: { count: row.checkedBelow } })}
            >
              {row.checkedBelow}
            </span>
          {/if}
          <!-- shown on hover or focus where there is a mouse, always on touch screens, and always once pinned -->
          <button
            type="button"
            class="flex size-6 shrink-0 items-center justify-center rounded-sm group-hover:opacity-100 hover:text-primary focus-visible:opacity-100 pointer-coarse:opacity-100 {pinned
              ? 'text-primary'
              : 'text-gray-500 opacity-0 dark:text-gray-400'}"
            aria-label={pinLabel}
            title={pinLabel}
            data-testid="tag-picker-pin"
            onclick={() => togglePinned(row.tag.id)}
          >
            <Icon icon={pinned ? mdiPin : mdiPinOutline} size="16" />
          </button>
        </li>
      {/each}
    </ul>

    {#if canCreate}
      <button
        type="button"
        class="mt-1 flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-start text-sm text-primary hover:bg-gray-100 dark:hover:bg-gray-800"
        onclick={create}
      >
        <Icon icon={mdiPlus} size="18" />
        <span class="truncate">{$t('create_tag_named', { values: { tag: newPath } })}</span>
      </button>
    {:else if rows.length === 0}
      <p class="py-2 text-sm text-gray-500 dark:text-gray-400">{$t('no_results')}</p>
    {/if}
  </div>
</div>
