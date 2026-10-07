<script lang="ts">
  import SearchHistorySection from './SearchHistorySection.svelte';
  import { t } from 'svelte-i18n';
  import { fly } from 'svelte/transition';
  import { Button, Text } from '@immich/ui';
  import {
    mdiAccount,
    mdiCalendarBlank,
    mdiChevronDown,
    mdiChevronUp,
    mdiImage,
    mdiImageAlbum,
    mdiMagnify,
    mdiMapMarker,
    mdiTagMultiple,
    mdiTune,
  } from '@mdi/js';
  import SearchLocationSection from './SearchLocationSection.svelte';
  import {
    getAllAlbums,
    getAllTags,
    type AlbumResponseDto,
    type PersonResponseDto,
    type TagResponseDto,
  } from '@immich/sdk';
  import SearchMediaSection from './SearchMediaSection.svelte';
  import SearchCameraSection from './SearchCameraSection.svelte';
  import SearchDateSection from './SearchDateSection.svelte';
  import SearchPeopleSection from './SearchPeopleSection.svelte';
  import SearchTagsSection from './SearchTagsSection.svelte';
  import SearchAlbumsSection from './SearchAlbumsSection.svelte';
  import SearchTextSection from './SearchTextSection.svelte';
  import SearchDisplaySection from './SearchDisplaySection.svelte';
  import SearchPrivateSection from './SearchPrivateSection.svelte';
  import SearchRatingsSection from './SearchRatingsSection.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
  import {
    getPeople,
    getSearchAlbumsTitle,
    getSearchDateFilterTitle,
    getSearchMediaTitle,
    getSearchPeopleFilterTitle,
    getSearchPeopleTitle,
    getSearchPlacesTitle,
    getSearchTagsTitle,
    getSearchTypeTitle,
  } from './search-bar-utils';
  import { onMount } from 'svelte';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import SearchButton from './SearchButton.svelte';

  interface Props {
    id: string;
    isOpen?: boolean;
    onSelectSearchTerm: (searchTerm: string) => void;
    onClearSearchTerm: (searchTerm: string) => void;
    onClearAllSearchTerms: () => void;
    onActiveSelectionChange: (selectedId: string | undefined) => void;
    onSearch: () => void;
  }

  let {
    id,
    isOpen = false,
    onSelectSearchTerm,
    onClearSearchTerm,
    onClearAllSearchTerms,
    onActiveSelectionChange,
    onSearch,
  }: Props = $props();

  let searchHistory = $state<SearchHistorySection>();
  let listbox = $state<HTMLElement>();
  let innerHeight = $state(0);
  // the panel ends above the bottom of the window: its filters scroll inside it, and the search button stays in reach
  let maxHeight = $derived.by(() => {
    if (!isOpen || !listbox || !innerHeight) {
      return;
    }
    return Math.max(innerHeight - listbox.getBoundingClientRect().top - 16, 240);
  });

  let activeFilter = $state('type');
  let showAdvanced = $state(false);
  let peoplePromise = $state<Promise<PersonResponseDto[]>>();
  let people = $state<PersonResponseDto[]>();
  let tagsPromise = $state<Promise<TagResponseDto[]>>();
  let tags = $state<TagResponseDto[]>();
  let albums = $state<AlbumResponseDto[]>();

  let typeTitle = $derived(getSearchTypeTitle(searchManager.filter.queryType));
  // the picked people's names, set here and by the People section
  let peopleNames = $state<string>();
  let peopleTitle = $derived(getSearchPeopleFilterTitle(peopleNames, searchManager.filter));
  let dateTitle = $derived(getSearchDateFilterTitle(searchManager.filter.date));
  let placesTitle = $derived(
    getSearchPlacesTitle(
      searchManager.filter.location.city,
      searchManager.filter.location.state,
      searchManager.filter.location.country,
    ),
  );
  let tagsTitle = $state<string>();
  let albumsTitle = $derived(
    searchManager.filter.display.isNotInAlbum
      ? $t('not_in_any_album')
      : getSearchAlbumsTitle(albums ?? [], searchManager.filter.albumIds, searchManager.filter.excludeAlbumIds),
  );
  let mediaTitle = $derived(
    getSearchMediaTitle(
      searchManager.filter.mediaType,
      searchManager.filter.minDuration,
      searchManager.filter.maxDuration,
    ),
  );

  let filters = [
    {
      name: 'type',
      icon: mdiMagnify,
      title: $t('search_type'),
      activeTitle: () => typeTitle,
    },
    {
      name: 'people',
      icon: mdiAccount,
      title: $t('people'),
      activeTitle: () => peopleTitle,
    },
    {
      name: 'date',
      icon: mdiCalendarBlank,
      title: $t('date'),
      activeTitle: () => dateTitle,
    },
    {
      name: 'places',
      icon: mdiMapMarker,
      title: $t('places'),
      activeTitle: () => placesTitle,
    },
    ...(authManager.authenticated && authManager.preferences.tags.enabled
      ? [
          {
            name: 'tags',
            icon: mdiTagMultiple,
            title: $t('tags'),
            activeTitle: () => tagsTitle,
          },
        ]
      : []),
    {
      name: 'albums',
      icon: mdiImageAlbum,
      title: $t('albums'),
      activeTitle: () => albumsTitle,
    },
    {
      name: 'media',
      icon: mdiImage,
      title: $t('media'),
      activeTitle: () => mediaTitle,
    },
  ];

  const advancedFiltersSet = $derived(
    searchManager.filter.display.isArchive ||
      searchManager.filter.display.isFavorite ||
      searchManager.filter.display.isNotInAlbum ||
      searchManager.filter.rating ||
      searchManager.filter.isPrivate !== undefined,
  );

  const clear = () => {
    searchManager.reset();
    peopleNames = tagsTitle = undefined;
  };

  onMount(() => {
    if (searchManager.filter.personIds.size > 0 && !peoplePromise) {
      peoplePromise = getPeople(searchManager.filter.personIds);
      void peoplePromise.then((res) => (people = res));
    }

    if (searchManager.filter.tagIds?.size && !tagsPromise) {
      tagsPromise = getAllTags();
      void tagsPromise.then((res) => (tags = res));
    }

    if (searchManager.filter.albumIds.size > 0 || searchManager.filter.excludeAlbumIds.size > 0) {
      void getAllAlbums({}).then((res) => (albums = res));
    }
  });

  $effect(() => {
    if (people) {
      peopleNames = getSearchPeopleTitle(people, searchManager.filter.personIds);
    }
  });

  $effect(() => {
    if (searchManager.filter.tagIds === null) {
      tagsTitle = $t('untagged');
    } else if (tags) {
      tagsTitle = getSearchTagsTitle(tags, searchManager.filter.tagIds, searchManager.filter.excludeTagIds);
    }
  });

  export function moveSelection(increment: 1 | -1) {
    if (searchHistory) {
      searchHistory.moveSelection(increment);
    }
  }

  export function clearSelection() {
    if (searchHistory) {
      searchHistory.clearSelection();
    }
  }

  export function selectActiveOption() {
    if (searchHistory) {
      searchHistory.selectActiveOption();
    }
  }
</script>

<svelte:window bind:innerHeight />

<div role="listbox" {id} bind:this={listbox}>
  {#if isOpen}
    <div
      transition:fly={{ y: 25, duration: 250 }}
      class="absolute z-1 flex w-full flex-col rounded-b-3xl bg-white shadow-[0_8px_20px_rgba(0,0,0,0.12)] transition-all dark:bg-immich-dark-gray dark:text-gray-300"
      style:max-height={maxHeight ? `${maxHeight}px` : undefined}
    >
      <div
        class="min-h-0 flex-1 immich-scrollbar overflow-y-auto overscroll-contain pb-5"
        data-testid="search-filters-scroll"
      >
        <SearchHistorySection
          bind:this={searchHistory}
          {onSelectSearchTerm}
          {onClearSearchTerm}
          {onClearAllSearchTerms}
          {onActiveSelectionChange}
        />
        <div class="px-5">
          <Text class="py-5" fontWeight="medium" aria-hidden={true}>{$t('filter_by')}</Text>
          <div class="flex flex-wrap gap-2">
            {#each filters as item (item.name)}
              <SearchButton
                active={activeFilter === item.name || Boolean(item.activeTitle())}
                leadingIcon={item.icon}
                class={activeFilter === item.name ? 'border-2' : undefined}
                onclick={() => (activeFilter = item.name)}
              >
                {item.activeTitle() ?? item.title}
              </SearchButton>
            {/each}
          </div>
        </div>
        {#if activeFilter}
          <div class="px-5 pt-5">
            {#if activeFilter === 'type'}
              <SearchTextSection />
            {:else if activeFilter === 'people'}
              <SearchPeopleSection bind:title={peopleNames} parentPromise={peoplePromise} />
            {:else if activeFilter === 'date'}
              <SearchDateSection />
            {:else if activeFilter === 'places'}
              <SearchLocationSection />
            {:else if activeFilter === 'tags'}
              <SearchTagsSection bind:title={tagsTitle} parentPromise={tagsPromise} />
            {:else if activeFilter === 'albums'}
              <SearchAlbumsSection bind:albums />
            {:else if activeFilter === 'media'}
              <SearchMediaSection />
            {/if}
          </div>
        {/if}
        <div
          class="grid transition-[grid-template-rows] duration-200 ease-in-out {showAdvanced
            ? 'grid-rows-[1fr]'
            : 'grid-rows-[0fr]'}"
          inert={!showAdvanced}
        >
          <div class="overflow-hidden">
            <div class="my-5 h-px w-full bg-light-200 dark:bg-dark-600"></div>
            <div class="px-5">
              <SearchCameraSection />
              {#if authManager.authenticated && authManager.preferences.ratings.enabled}
                <SearchRatingsSection />
              {/if}
              <SearchDisplaySection />
              {#if privateModeManager.enabled}
                <SearchPrivateSection />
              {/if}
            </div>
          </div>
        </div>
      </div>
      <div class="h-px w-full shrink-0 bg-light-200 dark:bg-dark-600"></div>
      <!-- wraps instead of growing past the panel on narrow screens -->
      <div class="flex shrink-0 flex-wrap items-center gap-2 p-5">
        <Button
          size="small"
          variant={advancedFiltersSet ? 'outline' : 'ghost'}
          leadingIcon={mdiTune}
          trailingIcon={showAdvanced ? mdiChevronUp : mdiChevronDown}
          onclick={() => (showAdvanced = !showAdvanced)}>{$t('advanced_filters')}</Button
        >
        <div class="ms-auto flex gap-2">
          <Button
            size="small"
            shape="round"
            variant="outline"
            color="secondary"
            class="bg-transparent"
            onclick={() => clear()}>{$t('clear_all')}</Button
          >
          <Button size="small" shape="round" onclick={() => onSearch()}>{$t('search')}</Button>
        </div>
      </div>
    </div>
  {/if}
</div>
