<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import {
    addPersonToAssets,
    BulkIdErrorReason,
    createPerson,
    getAllPeople,
    getPersonAssetCounts,
    removePersonFromAssets,
    type BulkIdResponseDto,
    type PersonAssetCountResponseDto,
    type PersonResponseDto,
  } from '@immich/sdk';
  import { FormModal, Icon, IconButton, Input, LoadingSpinner, Text, toastManager } from '@immich/ui';
  import { mdiAccount, mdiAccountMultipleOutline, mdiCheck, mdiClose, mdiMagnify, mdiMinus, mdiPlus } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { SvelteMap } from 'svelte/reactivity';

  interface Props {
    onClose: (updated?: boolean) => void;
    assetIds: string[];
  }

  let { onClose, assetIds }: Props = $props();

  const PAGE_SIZE = 1000;

  let people: PersonResponseDto[] = $state([]);
  // for every person on any of the assets: how many of them they are on, and on how many only through a mark
  let counts = $state<Record<string, PersonAssetCountResponseDto>>({});
  let loading = $state(true);
  let searchName = $state('');
  let isSubmitting = $state(false);
  // the people to add to every asset (true) or to take off every asset (false)
  const changes = new SvelteMap<string, boolean>();

  const total = $derived(assetIds.length);
  const countOf = (personId: string) => counts[personId]?.count ?? 0;
  const isChecked = (personId: string) => changes.get(personId) ?? countOf(personId) === total;
  const isPartial = (personId: string) => !changes.has(personId) && countOf(personId) > 0 && countOf(personId) < total;

  const search = $derived(normalizeSearchString(searchName.trim()));
  const filteredPeople = $derived(
    search ? people.filter((person) => normalizeSearchString(person.name).includes(search)) : people,
  );
  // a name nobody has yet can be created right here
  const newName = $derived(
    searchName.trim() && people.every((person) => normalizeSearchString(person.name) !== search)
      ? searchName.trim()
      : '',
  );
  const added = $derived(people.filter(({ id }) => changes.get(id) === true));
  const removed = $derived(people.filter(({ id }) => changes.get(id) === false));

  onMount(async () => {
    try {
      const [all, personCounts] = await Promise.all([
        (async () => {
          const result: PersonResponseDto[] = [];
          for (let page = 1; ; page++) {
            const response = await getAllPeople({ withHidden: false, page, size: PAGE_SIZE });
            result.push(...response.people);
            if (!response.hasNextPage) {
              return result;
            }
          }
        })(),
        getPersonAssetCounts({ personAssetCountsDto: { assetIds } }),
      ]);
      counts = Object.fromEntries(personCounts.map((count) => [count.personId, count]));
      // the people already on the selection first, then named people; the server orders by relevance within each
      const rank = (person: PersonResponseDto) => (countOf(person.id) > 0 ? 0 : person.name ? 1 : 2);
      people = [...all].sort((a, b) => rank(a) - rank(b));
    } catch (error) {
      handleError(error, $t('get_people_error'));
    } finally {
      loading = false;
    }
  });

  // an exact name first, then a name starting with the search, then the first person that contains it
  const bestMatch = $derived(
    filteredPeople.find(({ name }) => normalizeSearchString(name) === search) ??
      filteredPeople.find(({ name }) => normalizeSearchString(name).startsWith(search)) ??
      filteredPeople[0],
  );

  const setChecked = (personId: string, checked: boolean) => {
    const count = countOf(personId);
    const unchanged = (checked && count === total) || (!checked && count === 0);
    if (unchanged) {
      changes.delete(personId);
    } else {
      changes.set(personId, checked);
    }
  };

  const toggle = (person: PersonResponseDto) => setChecked(person.id, !isChecked(person.id));

  const onCreate = async () => {
    const name = newName;
    if (!name) {
      return;
    }

    try {
      const person = await createPerson({ personCreateDto: { name } });
      people = [person, ...people];
      setChecked(person.id, true);
      // keep whatever was typed while the person was being created
      if (searchName.trim() === name) {
        searchName = '';
      }
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  };

  const onSearchKeydown = async (event: KeyboardEvent) => {
    if (event.key !== 'Enter') {
      return;
    }

    // Enter adds the best match, or creates the typed name when nobody matches, instead of submitting the form
    event.preventDefault();
    if (!search) {
      return;
    }
    if (bestMatch) {
      setChecked(bestMatch.id, true);
      searchName = '';
    } else if (newName) {
      await onCreate();
    }
  };

  const namesOf = (list: PersonResponseDto[]) => list.map(({ name }) => name || $t('unknown')).join(', ');

  const onSubmit = async () => {
    if (changes.size === 0) {
      return;
    }

    isSubmitting = true;
    try {
      const addResults: BulkIdResponseDto[] = [];
      for (const person of added) {
        addResults.push(...(await addPersonToAssets({ id: person.id, bulkIdsDto: { ids: assetIds } })));
      }
      const removeResults: BulkIdResponseDto[] = [];
      for (const person of removed) {
        removeResults.push(...(await removePersonFromAssets({ id: person.id, bulkIdsDto: { ids: assetIds } })));
      }
      const idsWhere = (results: BulkIdResponseDto[], keep: (result: BulkIdResponseDto) => boolean) => [
        ...new Set(results.filter((result) => keep(result)).map(({ id }) => id)),
      ];
      const addedIds = idsWhere(addResults, ({ success }) => success);
      const removedIds = idsWhere(removeResults, ({ success }) => success);
      const keptIds = idsWhere(removeResults, ({ error }) => error === BulkIdErrorReason.Validation);

      const changedIds = [...new Set([...addedIds, ...removedIds])];
      if (changedIds.length > 0) {
        eventManager.emit('AssetsPeopleUpdate', changedIds);
      }
      if (addedIds.length > 0) {
        toastManager.primary(
          $t('added_people_to_assets', { values: { people: namesOf(added), count: addedIds.length } }),
        );
      }
      if (removedIds.length > 0) {
        toastManager.primary(
          $t('removed_people_from_assets', { values: { people: namesOf(removed), count: removedIds.length } }),
        );
      }
      if (keptIds.length > 0) {
        toastManager.info($t('people_kept_on_faces', { values: { count: keptIds.length } }));
      }
      if (changedIds.length === 0 && keptIds.length === 0) {
        toastManager.warning($t('people_nothing_changed'));
      }

      onClose(changedIds.length > 0);
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      isSubmitting = false;
    }
  };
</script>

{#snippet avatar(person: PersonResponseDto, size: string)}
  {#if person.thumbnailPath}
    <ImageThumbnail
      circle
      shadow={size === '100%'}
      url={getPeopleThumbnailUrl(person)}
      altText={person.name}
      widthStyle={size}
      heightStyle={size === '100%' ? undefined : size}
    />
  {:else}
    <!-- a person created here has no feature photo until they are on an asset -->
    <span
      class="flex aspect-square shrink-0 items-center justify-center rounded-full bg-subtle text-primary"
      style:width={size}
    >
      <Icon icon={mdiAccount} size={size === '100%' ? '50%' : '75%'} />
    </span>
  {/if}
{/snippet}

{#snippet changeChips(list: PersonResponseDto[], testId: string, label: string)}
  <div class="flex flex-col gap-1" data-testid={testId}>
    <Text size="small">{label}</Text>
    <div class="flex flex-wrap gap-2">
      {#each list as person (person.id)}
        <span class="flex items-center gap-1 rounded-full bg-primary/10 py-1 ps-1 pe-1 text-sm">
          {@render avatar(person, '1.5rem')}
          <span class="max-w-40 truncate">{person.name || $t('unknown')}</span>
          <IconButton
            icon={mdiClose}
            size="tiny"
            shape="round"
            variant="ghost"
            color="secondary"
            aria-label={$t('remove')}
            onclick={() => changes.delete(person.id)}
          />
        </span>
      {/each}
    </div>
  </div>
{/snippet}

<FormModal
  size="small"
  title={$t('people_edit_assets')}
  icon={mdiAccountMultipleOutline}
  {onClose}
  {onSubmit}
  submitText={$t('save')}
  disabled={changes.size === 0 || isSubmitting}
>
  <div class="my-4 flex flex-col gap-4">
    <Text size="small" color="muted">
      {$t('people_edit_assets_description', { values: { count: total } })}
    </Text>

    <Input
      bind:value={searchName}
      placeholder={$t('search_people')}
      leadingIcon={mdiMagnify}
      autofocus
      onkeydown={onSearchKeydown}
      aria-label={$t('search_people')}
      data-testid="people-search"
    />

    <div class="max-h-[45vh] immich-scrollbar overflow-y-auto">
      {#if loading}
        <div class="flex justify-center p-8">
          <LoadingSpinner />
        </div>
      {:else}
        {#if newName}
          <button
            type="button"
            class="mb-2 flex w-full items-center gap-2 rounded-xl p-2 text-start text-sm hover:bg-subtle"
            onclick={onCreate}
            data-testid="people-create"
          >
            <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Icon icon={mdiPlus} size="20" />
            </span>
            <span class="truncate">{$t('create_person_named', { values: { name: newName } })}</span>
          </button>
        {/if}

        {#if filteredPeople.length > 0}
          <div class="grid grid-cols-3 gap-2 p-1 sm:grid-cols-4">
            {#each filteredPeople as person (person.id)}
              {@const checked = isChecked(person.id)}
              {@const partial = isPartial(person.id)}
              <button
                type="button"
                onclick={() => toggle(person)}
                aria-pressed={partial ? 'mixed' : checked}
                data-partial={partial ? '' : undefined}
                title={partial
                  ? $t('people_on_some_assets', { values: { count: countOf(person.id), total } })
                  : undefined}
                class="relative flex flex-col items-center gap-1 rounded-xl p-2 transition-all hover:bg-subtle {checked
                  ? 'bg-primary/10 ring-2 ring-primary'
                  : partial
                    ? 'outline-2 outline-primary/60 outline-dashed'
                    : ''}"
              >
                {@render avatar(person, '100%')}
                {#if checked || partial}
                  <span
                    class="absolute inset-e-1 top-1 flex size-5 items-center justify-center rounded-full bg-primary text-light"
                  >
                    <Icon icon={checked ? mdiCheck : mdiMinus} size="14" />
                  </span>
                {/if}
                <span class="line-clamp-2 text-center text-xs font-medium">{person.name}</span>
              </button>
            {/each}
          </div>
        {:else if !newName}
          <p class="py-8 text-center text-sm text-gray-500">{$t('no_people_found')}</p>
        {/if}
      {/if}
    </div>

    {#if added.length > 0}
      {@render changeChips(added, 'people-changes-add', $t('people_changes_add'))}
    {/if}
    {#if removed.length > 0}
      {@render changeChips(removed, 'people-changes-remove', $t('people_changes_remove'))}
      {#each removed as person (person.id)}
        {@const kept = countOf(person.id) - (counts[person.id]?.removableCount ?? 0)}
        {#if kept > 0}
          <Text size="tiny" color="muted">
            {$t('people_stay_on_faces', { values: { name: person.name || $t('unknown'), count: kept } })}
          </Text>
        {/if}
      {/each}
    {/if}
  </div>
</FormModal>
