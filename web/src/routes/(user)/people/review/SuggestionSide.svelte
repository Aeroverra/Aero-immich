<script lang="ts">
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { getFaceThumbnailUrl, getPeopleThumbnailUrl } from '$lib/utils';
  import type { PersonSuggestionSideDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiOpenInNew } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  interface Props {
    side: PersonSuggestionSideDto;
    title: string;
  }

  let { side, title }: Props = $props();

  const formatDate = (date: string) => DateTime.fromISO(date).toLocaleString(DateTime.DATE_MED, { locale: $locale });

  // a single face gets a bigger tile than a grid of eight
  const columns = $derived(side.faces.length <= 2 ? 'grid-cols-2' : 'grid-cols-4');
</script>

{#snippet header()}
  {#if side.person}
    <img
      src={getPeopleThumbnailUrl(side.person)}
      alt=""
      class="size-11 shrink-0 rounded-full object-cover"
      draggable="false"
    />
  {/if}
  <div class="min-w-0">
    <p class="truncate font-medium" data-testid="suggestion-side-title">{title}</p>
    <p class="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400">
      {$t('same_person_photo_count', { values: { count: side.assetCount } })}
      {#if side.person}
        <Icon icon={mdiOpenInNew} size="14" aria-hidden="true" />
      {/if}
    </p>
  </div>
{/snippet}

<section
  class="flex flex-col gap-3 rounded-3xl border border-gray-200 p-3 sm:p-4 dark:border-gray-700"
  data-testid="suggestion-side"
>
  {#if side.person}
    <!-- the whole person, to check that everyone in it is the same before answering -->
    <a
      href={Route.viewPerson(side.person)}
      target="_blank"
      rel="noopener noreferrer"
      title={$t('same_person_open_person')}
      class="-m-1 flex min-w-0 items-center gap-3 rounded-2xl p-1 hover:bg-gray-100 dark:hover:bg-gray-800"
      data-testid="suggestion-side-person"
    >
      {@render header()}
    </a>
  {:else}
    <div class="flex min-w-0 items-center gap-3">
      {@render header()}
    </div>
  {/if}

  <div class="grid gap-2 {columns}">
    {#each side.faces as face (face.id)}
      <a
        href={Route.viewAsset({ id: face.assetId })}
        target="_blank"
        rel="noopener noreferrer"
        title={$t('same_person_open_photo', { values: { date: formatDate(face.takenAt) } })}
        class="block overflow-hidden rounded-2xl bg-gray-100 dark:bg-gray-800"
      >
        <img
          src={getFaceThumbnailUrl(face)}
          alt={formatDate(face.takenAt)}
          class="aspect-square w-full object-cover"
          draggable="false"
          data-testid="suggestion-face"
        />
      </a>
    {/each}
  </div>
</section>
