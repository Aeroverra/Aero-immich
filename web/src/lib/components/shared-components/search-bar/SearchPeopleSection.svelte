<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import { getPeople, getSearchExcludedPeopleTitle, getSearchPeopleTitle } from './search-bar-utils';
  import SingleGridRow from '$lib/components/shared-components/SingleGridRow.svelte';
  import SearchBar from '$lib/elements/SearchBar.svelte';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import { type PersonResponseDto } from '@immich/sdk';
  import { Button, Icon, LoadingSpinner, Text } from '@immich/ui';
  import { mdiAccountCancel, mdiArrowRight, mdiCheck, mdiClose } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import SearchButton from './SearchButton.svelte';

  interface Props {
    title: string | undefined;
    excludedTitle?: string;
    parentPromise: Promise<PersonResponseDto[]> | undefined;
  }

  // eslint-disable-next-line no-useless-assignment
  let { title = $bindable(), excludedTitle = $bindable(), parentPromise }: Props = $props();

  let selectedPeople = $derived(searchManager.filter.personIds);
  let excludedPeople = $derived(searchManager.filter.excludePersonIds);
  let filter = $derived(searchManager.filter);
  // picking people to find, or to leave out; starts on leaving out when only that was picked
  let excluding = $state(searchManager.filter.excludePersonIds.size > 0 && searchManager.filter.personIds.size === 0);
  // with no people, or nobody named, the picked people do not apply
  let peopleSetAside = $derived(filter.hasPeople === false || filter.hasNamedFaces === false);
  let noFaces = $derived(filter.hasPeople === false);
  let peoplePromise = parentPromise ?? getPeople(new Set([...selectedPeople, ...excludedPeople]));
  let showAllPeople = $state(false);
  let name = $state('');
  let numberOfPeople = $state(1);

  function togglePersonSelection(id: string, people: PersonResponseDto[]) {
    const [picked, other] = excluding ? [excludedPeople, selectedPeople] : [selectedPeople, excludedPeople];
    if (picked.has(id)) {
      picked.delete(id);
    } else {
      picked.add(id);
      other.delete(id);
    }

    title = getSearchPeopleTitle(people, selectedPeople);
    excludedTitle = getSearchExcludedPeopleTitle(people, excludedPeople);
  }

  const filterPeople = (list: PersonResponseDto[], name: string) => {
    const nameLower = name.toLowerCase();
    return name ? list.filter((p) => p.name.toLowerCase().includes(nameLower)) : list;
  };
</script>

<div class={peopleSetAside ? 'opacity-50' : undefined} inert={peopleSetAside}>
  {#await peoplePromise}
    <div id="spinner" class="-mb-4 flex h-54 items-center justify-center">
      <LoadingSpinner size="large" />
    </div>
  {:then people}
    {#if people && people.length > 0}
      {@const peopleList = showAllPeople
        ? filterPeople(people, name)
        : filterPeople(people, name).slice(0, numberOfPeople)}

      <!-- outside the list's scroller, so the lists can always be switched -->
      <div class="flex flex-wrap gap-2 pb-3" data-testid="search-people-mode">
        <SearchButton checked active={!excluding} onclick={() => (excluding = false)}
          >{$t('search_include_people')}</SearchButton
        >
        <SearchButton checked active={excluding} onclick={() => (excluding = true)}
          >{$t('search_exclude_people')}</SearchButton
        >
      </div>
      <div id="people-selection" class="max-h-80 immich-scrollbar overflow-y-auto">
        <Text class="pb-5">{$t(excluding ? 'search_exclude_people_description' : 'people_search_description')}</Text>
        <SearchBar bind:name placeholder={$t('filter_people')} showLoadingSpinner={false} />

        <SingleGridRow
          class="space-between grid immich-scrollbar grid-auto-fill-20 gap-5 overflow-y-auto pt-5"
          bind:itemCount={numberOfPeople}
        >
          {#each peopleList as person (person.id)}
            <button
              type="button"
              class="flex flex-col items-center rounded-3xl border-none p-0 transition-all"
              aria-pressed={excluding ? excludedPeople.has(person.id) : selectedPeople.has(person.id)}
              onclick={() => togglePersonSelection(person.id, people)}
            >
              <div class="relative w-full">
                <ImageThumbnail
                  circle
                  shadow
                  url={getPeopleThumbnailUrl(person)}
                  altText={person.name}
                  widthStyle="100%"
                />
                {#if selectedPeople.has(person.id)}
                  <div
                    class="absolute top-0 flex size-full items-center justify-center rounded-full bg-primary opacity-75"
                  >
                    <Icon icon={mdiCheck} size="32" color="white" />
                  </div>
                {:else if excludedPeople.has(person.id)}
                  <div
                    class="absolute top-0 flex size-full items-center justify-center rounded-full bg-danger opacity-75"
                    data-testid="search-person-excluded"
                  >
                    <Icon icon={mdiAccountCancel} size="32" color="white" />
                  </div>
                {/if}
              </div>
              <p
                class="mt-2 line-clamp-2 text-sm font-medium dark:text-white {excludedPeople.has(person.id)
                  ? 'line-through'
                  : ''}"
              >
                {person.name}
              </p>
            </button>
          {/each}
        </SingleGridRow>

        {#if showAllPeople || people.length > peopleList.length}
          <div class="mt-2 flex justify-center">
            <Button
              size="small"
              color="primary"
              variant="ghost"
              shape="round"
              leadingIcon={showAllPeople ? mdiClose : mdiArrowRight}
              class="flex place-items-center gap-2"
              onclick={() => (showAllPeople = !showAllPeople)}
            >
              {showAllPeople ? $t('collapse') : $t('see_all_people')}
            </Button>
          </div>
        {/if}
      </div>
    {/if}
  {/await}
</div>

{#snippet choice(
  value: boolean | undefined,
  onChange: (value: boolean | undefined) => void,
  sides: [{ label: string; description: string }, { label: string; description: string }],
  disabled: boolean,
  testId: string,
)}
  <!-- one side or the other; picking the active side again clears it -->
  <div class="flex flex-wrap gap-2" data-testid={testId}>
    {#each [true, false] as side, index (side)}
      <SearchButton
        checked
        active={!disabled && value === side}
        {disabled}
        title={sides[index].description}
        onclick={() => onChange(value === side ? undefined : side)}>{sides[index].label}</SearchButton
      >
    {/each}
  </div>
{/snippet}

<div class="flex flex-col gap-2 pt-5" data-testid="search-people-options">
  {@render choice(
    filter.onlyPersonIds,
    (value) => (filter.onlyPersonIds = value),
    [
      { label: $t('search_filter_only_people'), description: $t('search_filter_only_people_description') },
      { label: $t('search_filter_with_others'), description: $t('search_filter_with_others_description') },
    ],
    selectedPeople.size === 0 || peopleSetAside,
    'search-people-only',
  )}
  {@render choice(
    filter.hasNamedFaces,
    (value) => (filter.hasNamedFaces = value),
    [
      { label: $t('search_filter_with_named_people'), description: $t('search_filter_with_named_people_description') },
      { label: $t('search_filter_no_named_people'), description: $t('search_filter_no_named_people_description') },
    ],
    noFaces,
    'search-people-named',
  )}
  {@render choice(
    filter.hasUnnamedFaces,
    (value) => (filter.hasUnnamedFaces = value),
    [
      {
        label: $t('search_filter_with_unnamed_faces'),
        description: $t('search_filter_with_unnamed_faces_description'),
      },
      { label: $t('search_filter_no_unnamed_faces'), description: $t('search_filter_no_unnamed_faces_description') },
    ],
    noFaces,
    'search-people-unnamed',
  )}
  {@render choice(
    filter.hasPeople,
    (value) => (filter.hasPeople = value),
    [
      { label: $t('search_filter_with_people'), description: $t('search_filter_with_people_description') },
      { label: $t('search_filter_no_people'), description: $t('search_filter_no_people_description') },
    ],
    false,
    'search-people-any',
  )}
</div>
{#if filter.onlyPersonIds !== undefined && selectedPeople.size > 0 && !peopleSetAside}
  <Text size="small" color="muted" class="pt-2"
    >{$t(
      filter.onlyPersonIds ? 'search_filter_only_people_description' : 'search_filter_with_others_description',
    )}</Text
  >
{/if}
