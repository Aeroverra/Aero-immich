<script lang="ts">
  import Combobox, { type ComboBoxOption } from '$lib/components/shared-components/Combobox.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAllTags, type TagResponseDto } from '@immich/sdk';
  import { Button, Text } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { SvelteSet } from 'svelte/reactivity';
  import { mdiClose, mdiTagOffOutline } from '@mdi/js';
  import SearchButton from './SearchButton.svelte';
  import { getSearchTagsTitle } from './search-bar-utils';
  import { searchManager } from '$lib/managers/search-manager.svelte';

  interface Props {
    title: string | undefined;
    parentPromise: Promise<TagResponseDto[]> | undefined;
  }

  // eslint-disable-next-line no-useless-assignment
  let { title = $bindable(), parentPromise }: Props = $props();

  let container = $state<HTMLDivElement>();
  let selectedTags = $derived(searchManager.filter.tagIds);
  let excludedTags = $derived(searchManager.filter.excludeTagIds);
  let allTags: TagResponseDto[] = $state([]);
  let tagMap = $derived(Object.fromEntries(allTags.map((tag) => [tag.id, tag])));
  let selectedOption = $state(undefined);
  let excludedOption = $state(undefined);
  const updateTitle = () => {
    title = getSearchTagsTitle(allTags, selectedTags ?? new SvelteSet(), excludedTags);
  };

  onMount(() => {
    if (parentPromise) {
      void parentPromise.then((res) => (allTags = res));
    } else {
      void getAllTags().then((res) => (allTags = res));
    }
  });

  const handleSelect = (option?: ComboBoxOption) => {
    if (!option || !option.id || selectedTags === null) {
      return;
    }

    selectedTags.add(option.value);
    excludedTags.delete(option.value);
    selectedOption = undefined;
    updateTitle();
  };

  const handleExclude = (option?: ComboBoxOption) => {
    if (!option || !option.id || selectedTags === null) {
      return;
    }

    excludedTags.add(option.value);
    selectedTags.delete(option.value);
    excludedOption = undefined;
    updateTitle();
  };

  const handleRemoveExcluded = (tag: string) => {
    container?.focus();
    excludedTags.delete(tag);
    updateTitle();
  };

  const handleRemove = (tag: string) => {
    if (selectedTags === null) {
      return;
    }

    // Move focus back to the container so it doesn't fallback to the body and closes the search bar
    container?.focus();
    selectedTags.delete(tag);
    updateTitle();
  };

  const handleToggleUntagged = () => {
    const isSearchUntagged = selectedTags === null;

    searchManager.filter.tagIds = isSearchUntagged ? new SvelteSet() : null;
    title = isSearchUntagged ? undefined : $t('untagged');
  };
</script>

{#if authManager.authenticated && authManager.preferences.tags.enabled}
  <div id="location-selection" bind:this={container} tabindex="-1">
    <form autocomplete="off" id="create-tag-form">
      <Text class="pb-5">{$t('search_filter_tags_description')}</Text>
      <Combobox
        disabled={selectedTags === null}
        hideLabel
        onSelect={handleSelect}
        label={$t('tags')}
        defaultFirstOption
        options={allTags.map((tag) => ({ id: tag.id, label: tag.value, value: tag.id }))}
        bind:selectedOption
        placeholder={$t('search_tags')}
      />
    </form>

    {#if selectedTags?.size}
      <section class="flex flex-wrap gap-2 pt-5">
        {#each selectedTags as tagId (tagId)}
          {@const tag = tagMap[tagId]}
          {#if tag}
            <Button
              size="small"
              shape="round"
              color="primary"
              variant="outline"
              onclick={() => handleRemove(tagId)}
              trailingIcon={mdiClose}
              >{tag.value}
            </Button>
          {/if}
        {/each}
      </section>
    {/if}

    <form autocomplete="off" class="pt-5" data-testid="search-exclude-tags">
      <Combobox
        disabled={selectedTags === null}
        label={$t('search_exclude_tags')}
        onSelect={handleExclude}
        defaultFirstOption
        options={allTags.map((tag) => ({ id: tag.id, label: tag.value, value: tag.id }))}
        bind:selectedOption={excludedOption}
        placeholder={$t('search_exclude_tags_placeholder')}
      />
    </form>

    {#if excludedTags.size > 0 && selectedTags !== null}
      <section class="flex flex-wrap gap-2 pt-3">
        {#each excludedTags as tagId (tagId)}
          {@const tag = tagMap[tagId]}
          {#if tag}
            <Button
              size="small"
              shape="round"
              color="danger"
              variant="outline"
              aria-label={$t('search_without_tag', { values: { tag: tag.value } })}
              onclick={() => handleRemoveExcluded(tagId)}
              leadingIcon={mdiTagOffOutline}
              trailingIcon={mdiClose}
              >{tag.value}
            </Button>
          {/if}
        {/each}
      </section>
    {/if}

    <div class="flex flex-wrap gap-2 pt-5">
      <SearchButton checked active={selectedTags === null} onclick={handleToggleUntagged}>{$t('untagged')}</SearchButton
      >
    </div>
  </div>
{/if}
