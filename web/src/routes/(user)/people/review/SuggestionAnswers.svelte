<script lang="ts">
  import { getFaceThumbnailUrl, getPeopleThumbnailUrl } from '$lib/utils';
  import { PersonSuggestionStatus, type PersonSuggestionResponseDto } from '@immich/sdk';
  import { Button } from '@immich/ui';
  import { mdiUndo } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    answers: PersonSuggestionResponseDto[];
    busy?: boolean;
    onUndo: (answer: PersonSuggestionResponseDto) => void;
  }

  let { answers, busy = false, onUndo }: Props = $props();

  const labels: Record<string, string> = $derived({
    [PersonSuggestionStatus.Same]: $t('same_person_answer_same'),
    [PersonSuggestionStatus.Different]: $t('same_person_answer_different'),
    [PersonSuggestionStatus.Skipped]: $t('same_person_answer_skipped'),
  });
</script>

<section class="flex flex-col gap-2" data-testid="suggestion-answers">
  <h3 class="text-sm font-medium text-gray-600 dark:text-gray-400">{$t('same_person_recent_answers')}</h3>
  <ul class="flex flex-col divide-y divide-gray-200 dark:divide-gray-700">
    {#each answers as answer (answer.id)}
      <li class="flex items-center gap-3 py-2" data-testid="suggestion-answer">
        <div class="flex shrink-0 -space-x-2">
          {#each answer.candidate.faces.slice(0, 2) as face (face.id)}
            <img
              src={getFaceThumbnailUrl(face)}
              alt=""
              class="size-9 rounded-full border-2 border-light object-cover"
              draggable="false"
            />
          {/each}
          {#if answer.target.person}
            <img
              src={getPeopleThumbnailUrl(answer.target.person)}
              alt=""
              class="size-9 rounded-full border-2 border-light object-cover"
              draggable="false"
            />
          {/if}
        </div>
        <div class="min-w-0 grow">
          <p class="truncate text-sm">{answer.target.person?.name || $t('same_person_unknown')}</p>
          <p class="text-xs text-gray-600 dark:text-gray-400">{labels[answer.status] ?? answer.status}</p>
        </div>
        <Button
          size="small"
          variant="ghost"
          color="secondary"
          leadingIcon={mdiUndo}
          disabled={busy}
          onclick={() => onUndo(answer)}>{$t('same_person_undo')}</Button
        >
      </li>
    {/each}
  </ul>
</section>
