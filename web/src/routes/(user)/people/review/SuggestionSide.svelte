<script lang="ts">
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { getFaceThumbnailUrl, getPeopleThumbnailUrl } from '$lib/utils';
  import type { PersonSuggestionSideDto } from '@immich/sdk';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  interface Props {
    side: PersonSuggestionSideDto;
    title: string;
    /** show the person's picture and link to the person */
    showPerson?: boolean;
    /** fewer, smaller faces (recent answers) */
    compact?: boolean;
  }

  let { side, title, showPerson = false, compact = false }: Props = $props();

  const formatDate = (date: string) => DateTime.fromISO(date).toLocaleString(DateTime.DATE_MED, { locale: $locale });

  // a single face gets a bigger tile than a grid of eight
  const columns = $derived(compact ? 'grid-cols-4' : side.faces.length <= 2 ? 'grid-cols-2' : 'grid-cols-4');
</script>

<section
  class="flex flex-col gap-3 rounded-3xl border border-gray-200 p-3 sm:p-4 dark:border-gray-700"
  data-testid="suggestion-side"
>
  <div class="flex min-w-0 items-center gap-3">
    {#if showPerson && side.person}
      <a href={Route.viewPerson(side.person)} target="_blank" rel="noopener noreferrer" class="shrink-0">
        <img
          src={getPeopleThumbnailUrl(side.person)}
          alt={side.person.name}
          class="size-11 rounded-full object-cover"
          draggable="false"
        />
      </a>
    {/if}
    <div class="min-w-0">
      <p class="truncate font-medium" data-testid="suggestion-side-title">{title}</p>
      <p class="text-sm text-gray-600 dark:text-gray-400">
        {$t('same_person_photo_count', { values: { count: side.assetCount } })}
      </p>
    </div>
  </div>

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
