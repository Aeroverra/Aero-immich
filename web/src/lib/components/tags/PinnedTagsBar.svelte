<script lang="ts">
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { tagPicker } from '$lib/components/tags/tag-picker.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { resolveStackSelection } from '$lib/services/stack-selection.service';
  import { handleTagAssetsChanges } from '$lib/services/tag.service';
  import { getPinnedTags, getTagCoverage, nextTagChange, type TagCoverage } from '$lib/utils/pinned-tags';
  import { tagName } from '$lib/utils/tag-tree';
  import { getAllTags, getTagAssetCounts, type TagResponseDto } from '@immich/sdk';
  import { Button, Icon, IconButton } from '@immich/ui';
  import { mdiCheck, mdiClose, mdiMinus, mdiPinOff, mdiTagMinusOutline, mdiTagPlusOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { SvelteMap } from 'svelte/reactivity';

  /** wait for a burst of selection changes (shift click, select all) before counting the tags */
  const COUNT_DELAY_MS = 150;

  let tags = $state<TagResponseDto[]>([]);
  // how many of the selected assets carry each pinned tag
  let counts = $state<Record<string, number>>({});
  let countedIds = $state<string[]>([]);
  let isSaving = $state(false);
  // the staged changes, like in the tag dialog: add the tag to every selected asset (true) or take it off all (false)
  const changes = new SvelteMap<string, boolean>();

  const pinnedTags = $derived(getPinnedTags(tagPicker.pinned.current, tags));
  const assetIds = $derived(assetMultiSelectManager.ownedAssets.map(({ id }) => id));
  const assetKey = $derived(assetIds.join(','));
  // the counts belong to an earlier selection until the new ones arrive; show the chips as unknown meanwhile
  const isCounted = $derived(countedIds.join(',') === assetKey);

  const loadTags = async () => {
    try {
      tags = await getAllTags();
      // forget the pins of tags that were deleted
      const existing = new Set(tags.map(({ id }) => id));
      const pinned = tagPicker.pinned.current;
      if (pinned.some((id) => !existing.has(id))) {
        tagPicker.pinned.current = pinned.filter((id) => existing.has(id));
      }
    } catch (error) {
      // the bar only offers shortcuts; without the tags it stays empty instead of showing an error
      console.warn('Could not load the pinned tags', error);
    }
  };

  let countRequest = 0;
  const loadCounts = async (ids: string[]) => {
    const request = ++countRequest;
    try {
      const result = await getTagAssetCounts({ tagAssetCountsDto: { assetIds: ids } });
      if (request === countRequest) {
        counts = Object.fromEntries(result.map(({ tagId, count }) => [tagId, count]));
        countedIds = ids;
      }
    } catch (error) {
      // a background refresh: keep the chips usable with what is known instead of showing an error
      console.warn('Could not count the tags of the selection', error);
      if (request === countRequest) {
        countedIds = ids;
      }
    }
  };

  onMount(() => {
    void loadTags();
  });

  $effect(() => {
    const ids = assetIds;
    if (ids.length === 0 || pinnedTags.length === 0) {
      return;
    }
    const timer = setTimeout(() => void loadCounts(ids), COUNT_DELAY_MS);
    return () => clearTimeout(timer);
  });

  const coverageOf = (tag: TagResponseDto): TagCoverage =>
    isCounted ? getTagCoverage(counts[tag.id] ?? 0, assetIds.length) : 'none';

  const onToggle = (tag: TagResponseDto) => {
    const change = nextTagChange(changes.get(tag.id), coverageOf(tag));
    if (change === undefined) {
      changes.delete(tag.id);
    } else {
      changes.set(tag.id, change);
    }
  };

  const onUnpin = (tag: TagResponseDto) => {
    changes.delete(tag.id);
    tagPicker.pinned.current = tagPicker.pinned.current.filter((id) => id !== tag.id);
  };

  const onSave = async () => {
    if (changes.size === 0 || isSaving) {
      return;
    }

    isSaving = true;
    try {
      // the same stacks rule as the tag dialog: a manual stack is tagged as a whole
      const ids = await resolveStackSelection(assetMultiSelectManager.ownedAssets);
      if (!ids) {
        return;
      }

      const entries = [...changes.entries()];
      const saved = await handleTagAssetsChanges({
        assetIds: ids,
        addIds: entries.filter(([, add]) => add).map(([id]) => id),
        removeIds: entries.filter(([, add]) => !add).map(([id]) => id),
        tags,
      });
      if (saved) {
        changes.clear();
      }
    } finally {
      isSaving = false;
    }
  };

  const chipLabel = (tag: TagResponseDto, coverage: TagCoverage, change: boolean | undefined) => {
    const values = { tag: tag.value };
    if (change === true) {
      return $t('tag_pinned_add', { values });
    }
    if (change === false) {
      return $t('tag_pinned_remove', { values });
    }
    switch (coverage) {
      case 'all': {
        return $t('tag_pinned_all', { values });
      }
      case 'some': {
        return $t('tag_pinned_some', { values });
      }
      default: {
        return $t('tag_pinned_none', { values });
      }
    }
  };

  const refreshCounts = () => {
    if (assetIds.length > 0 && pinnedTags.length > 0) {
      void loadCounts(assetIds);
    }
  };

  const chipClass = (shown: TagCoverage) => {
    switch (shown) {
      case 'all': {
        return 'border-primary bg-primary text-light';
      }
      case 'some': {
        return 'border-primary bg-primary/15 text-primary';
      }
      default: {
        return 'border-gray-300 text-gray-700 hover:border-primary hover:text-primary dark:border-gray-600 dark:text-gray-200';
      }
    }
  };

  const chipIcon = (shown: TagCoverage, change: boolean | undefined) => {
    if (change !== undefined) {
      return change ? mdiTagPlusOutline : mdiTagMinusOutline;
    }
    if (shown === 'all') {
      return mdiCheck;
    }
    return shown === 'some' ? mdiMinus : undefined;
  };
</script>

<OnEvents
  onAssetsTag={refreshCounts}
  onTagCreate={() => void loadTags()}
  onTagUpdate={() => void loadTags()}
  onTagDelete={() => void loadTags()}
/>

{#if pinnedTags.length > 0}
  <!-- in the bar on wide screens; on narrow ones a row of its own below it, so the actions keep their room -->
  <div
    class="flex min-w-0 grow items-center gap-1 max-md:absolute max-md:inset-x-2 max-md:top-full max-md:h-12 max-md:rounded-full max-md:bg-light-100 max-md:px-2 max-md:shadow-md"
    role="group"
    aria-label={$t('tag_pinned_tags')}
    data-testid="pinned-tags-bar"
  >
    <div class="flex min-w-0 grow [scrollbar-width:none] items-center gap-1.5 overflow-x-auto p-1">
      {#each pinnedTags as tag (tag.id)}
        {@const change = changes.get(tag.id)}
        {@const coverage = coverageOf(tag)}
        {@const shown = change === undefined ? coverage : change ? 'all' : 'none'}
        {@const icon = chipIcon(shown, change)}
        <div
          class="group/chip flex shrink-0 items-center rounded-full border text-sm transition-colors {chipClass(
            shown,
          )} {change === undefined ? '' : 'ring-2 ring-warning ring-offset-1 ring-offset-light-100'} {isCounted
            ? ''
            : 'opacity-60'}"
          data-testid="pinned-tag"
          data-tag-value={tag.value}
          data-coverage={coverage}
          data-change={change === undefined ? undefined : change ? 'add' : 'remove'}
        >
          <button
            type="button"
            class="flex items-center gap-1 rounded-full py-0.5 ps-2.5 pe-1 whitespace-nowrap {change === false
              ? 'line-through'
              : ''}"
            title={tag.value}
            aria-label={chipLabel(tag, coverage, change)}
            disabled={isSaving || !isCounted}
            onclick={() => onToggle(tag)}
          >
            {#if icon}
              <Icon {icon} size="14" />
            {/if}
            {tagName(tag.value)}
          </button>
          <!-- shown on hover or focus where there is a mouse, always on touch screens -->
          <button
            type="button"
            class="me-1 flex size-5 items-center justify-center rounded-full opacity-0 group-focus-within/chip:opacity-100 group-hover/chip:opacity-100 hover:bg-black/10 dark:hover:bg-white/10 pointer-coarse:opacity-100"
            title={$t('tag_unpin', { values: { tag: tag.value } })}
            aria-label={$t('tag_unpin', { values: { tag: tag.value } })}
            onclick={() => onUnpin(tag)}
          >
            <Icon icon={mdiPinOff} size="12" />
          </button>
        </div>
      {/each}
    </div>

    {#if changes.size > 0}
      <IconButton
        icon={mdiClose}
        size="small"
        shape="round"
        variant="ghost"
        color="secondary"
        aria-label={$t('tag_pinned_discard')}
        title={$t('tag_pinned_discard')}
        disabled={isSaving}
        onclick={() => changes.clear()}
      />
      <Button size="small" shape="round" loading={isSaving} onclick={onSave} data-testid="pinned-tags-save">
        {$t('save')}
      </Button>
    {/if}
  </div>
{/if}
