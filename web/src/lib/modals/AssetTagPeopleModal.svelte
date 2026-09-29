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
    type BulkIdResponseDto,
    type PersonResponseDto,
  } from '@immich/sdk';
  import { FormModal, Icon, IconButton, Input, LoadingSpinner, Text, toastManager } from '@immich/ui';
  import { mdiAccountPlusOutline, mdiClose, mdiMagnify, mdiPlus } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    onClose: (updated?: boolean) => void;
    assetIds: string[];
  }

  let { onClose, assetIds }: Props = $props();

  const PAGE_SIZE = 1000;

  let people: PersonResponseDto[] = $state([]);
  let loading = $state(true);
  let searchName = $state('');
  let selected: PersonResponseDto[] = $state([]);
  let isSubmitting = $state(false);

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
  const selectedIds = $derived(new Set(selected.map(({ id }) => id)));

  onMount(async () => {
    try {
      const all: PersonResponseDto[] = [];
      for (let page = 1; ; page++) {
        const result = await getAllPeople({ withHidden: false, page, size: PAGE_SIZE });
        all.push(...result.people);
        if (!result.hasNextPage) {
          break;
        }
      }
      // named people first, the server already puts the most relevant first within each
      people = [...all.filter(({ name }) => name), ...all.filter(({ name }) => !name)];
    } catch (error) {
      handleError(error, $t('get_people_error'));
    } finally {
      loading = false;
    }
  });

  const toggle = (person: PersonResponseDto) => {
    selected = selectedIds.has(person.id) ? selected.filter(({ id }) => id !== person.id) : [...selected, person];
  };

  const onCreate = async () => {
    const name = newName;
    if (!name) {
      return;
    }

    try {
      const person = await createPerson({ personCreateDto: { name } });
      people = [person, ...people];
      selected = [...selected, person];
      searchName = '';
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  };

  const onSearchKeydown = async (event: KeyboardEvent) => {
    if (event.key !== 'Enter') {
      return;
    }

    // Enter picks the only match or creates the typed name instead of submitting the form
    event.preventDefault();
    if (filteredPeople.length === 1) {
      toggle(filteredPeople[0]);
      searchName = '';
    } else if (newName) {
      await onCreate();
    }
  };

  const onSubmit = async () => {
    if (selected.length === 0) {
      return;
    }

    isSubmitting = true;
    try {
      const results: BulkIdResponseDto[] = [];
      for (const person of selected) {
        results.push(...(await addPersonToAssets({ id: person.id, bulkIdsDto: { ids: assetIds } })));
      }
      const taggedIds = new Set(results.filter(({ success }) => success).map(({ id }) => id));
      const photoIds = new Set(
        results.filter(({ error }) => error === BulkIdErrorReason.Validation).map(({ id }) => id),
      );

      if (taggedIds.size > 0) {
        eventManager.emit('PersonAssetsAdd', [...taggedIds]);
        const names = selected.map(({ name }) => name || $t('unknown')).join(', ');
        toastManager.primary($t('tagged_people_in_videos', { values: { people: names, count: taggedIds.size } }));
      } else {
        toastManager.warning($t('tag_people_nothing_to_tag'));
      }
      if (photoIds.size > 0) {
        toastManager.info($t('tag_people_photos_skipped', { values: { count: photoIds.size } }));
      }

      onClose(taggedIds.size > 0);
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      isSubmitting = false;
    }
  };
</script>

<FormModal
  size="small"
  title={$t('tag_people_in_videos')}
  icon={mdiAccountPlusOutline}
  {onClose}
  {onSubmit}
  submitText={$t('tag')}
  disabled={selected.length === 0 || isSubmitting}
>
  <div class="my-4 flex flex-col gap-4">
    <Text size="small" color="muted">
      {$t('tag_people_in_videos_description', { values: { count: assetIds.length } })}
    </Text>

    <Input
      bind:value={searchName}
      placeholder={$t('search_people')}
      leadingIcon={mdiMagnify}
      autofocus
      onkeydown={onSearchKeydown}
      aria-label={$t('search_people')}
      data-testid="tag-people-search"
    />

    {#if selected.length > 0}
      <div class="flex flex-wrap gap-2" data-testid="tag-people-selected">
        {#each selected as person (person.id)}
          <span class="flex items-center gap-1 rounded-full bg-primary/10 py-1 ps-1 pe-1 text-sm">
            <ImageThumbnail
              circle
              url={getPeopleThumbnailUrl(person)}
              altText={person.name}
              widthStyle="1.5rem"
              heightStyle="1.5rem"
            />
            <span class="max-w-40 truncate">{person.name || $t('unknown')}</span>
            <IconButton
              icon={mdiClose}
              size="tiny"
              shape="round"
              variant="ghost"
              color="secondary"
              aria-label={$t('remove')}
              onclick={() => toggle(person)}
            />
          </span>
        {/each}
      </div>
    {/if}

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
            data-testid="tag-people-create"
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
              {@const isSelected = selectedIds.has(person.id)}
              <button
                type="button"
                onclick={() => toggle(person)}
                aria-pressed={isSelected}
                class="flex flex-col items-center gap-1 rounded-xl p-2 transition-all hover:bg-subtle {isSelected
                  ? 'bg-primary/10 ring-2 ring-primary'
                  : ''}"
              >
                <ImageThumbnail
                  circle
                  shadow
                  url={getPeopleThumbnailUrl(person)}
                  altText={person.name}
                  widthStyle="100%"
                />
                <span class="line-clamp-2 text-center text-xs font-medium">{person.name}</span>
              </button>
            {/each}
          </div>
        {:else if !newName}
          <p class="py-8 text-center text-sm text-gray-500">{$t('no_people_found')}</p>
        {/if}
      {/if}
    </div>
  </div>
</FormModal>
