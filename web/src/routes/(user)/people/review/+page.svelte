<script lang="ts">
  import { shortcuts } from '$lib/actions/shortcut';
  import SuggestionAnswers from './SuggestionAnswers.svelte';
  import SuggestionQuestion from './SuggestionQuestion.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { getFaceThumbnailUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    answerPersonSuggestion,
    getPersonSuggestions,
    getPersonSuggestionStatistics,
    mergePeople,
    PersonSuggestionAnswer,
    refreshPersonSuggestions,
    undoPersonSuggestionAnswer,
    type PersonResponseDto,
    type PersonSuggestionResponseDto,
  } from '@immich/sdk';
  import { Button, Icon, LoadingSpinner, toastManager } from '@immich/ui';
  import { mdiAccountQuestionOutline, mdiArrowLeft, mdiMagnify, mdiUndo } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // the page keeps its own list from here on: answers take questions off it and undo puts them back
  // svelte-ignore state_referenced_locally
  let queue = $state<PersonSuggestionResponseDto[]>(data.suggestions.suggestions);
  // svelte-ignore state_referenced_locally
  let total = $state(data.suggestions.total);
  // svelte-ignore state_referenced_locally
  let answers = $state<PersonSuggestionResponseDto[]>(data.answers);
  let busy = $state(false);
  let isLooking = $state(false);

  const current = $derived(queue[0]);
  // when coming from a person's page, only the questions about that person
  const person = $derived(data.person);
  const personId = $derived(person?.id);
  const personName = $derived(person?.name || $t('same_person_unknown'));

  // the next question's faces load while this one is answered
  $effect(() => {
    for (const face of [...(queue[1]?.candidate.faces ?? []), ...(queue[1]?.target.faces ?? [])]) {
      const image = new Image();
      image.src = getFaceThumbnailUrl(face);
    }
  });

  const refill = async () => {
    if (queue.length >= 3) {
      return;
    }

    const response = await getPersonSuggestions({ size: 10, personId });
    const known = new Set(queue.map(({ id }) => id));
    queue = [...queue, ...response.suggestions.filter(({ id }) => !known.has(id))];
    total = response.total;
  };

  const handleAnswer = async (answer: PersonSuggestionAnswer, name?: string, existing?: PersonResponseDto) => {
    const suggestion = current;
    if (!suggestion || busy) {
      return;
    }

    busy = true;
    try {
      // a name that already belongs to someone means the merged person goes into them
      const answered = await answerPersonSuggestion({
        id: suggestion.id,
        personSuggestionAnswerDto: { answer, name: existing ? undefined : name },
      });
      if (existing && answered.target.person && existing.id !== answered.target.person.id) {
        await mergePeople({ mergePersonDto: { ids: [existing.id, answered.target.person.id] } });
      }

      answers = [answered, ...answers.filter(({ id }) => id !== answered.id)].slice(0, 10);
      queue = queue.filter(({ id }) => id !== suggestion.id);
      total = Math.max(0, total - 1);
      await refill();
      if (!queue[0]) {
        toastManager.primary($t('same_person_done'));
      }
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      busy = false;
    }
  };

  const handleUndo = async (answer?: PersonSuggestionResponseDto) => {
    const target = answer ?? answers[0];
    if (!target || busy) {
      return;
    }

    busy = true;
    try {
      const reopened = await undoPersonSuggestionAnswer({ id: target.id });
      answers = answers.filter(({ id }) => id !== reopened.id);
      queue = [reopened, ...queue.filter(({ id }) => id !== reopened.id)];
      total += 1;
      toastManager.primary($t('same_person_undone'));
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      busy = false;
    }
  };

  let lookTimer: ReturnType<typeof setTimeout> | undefined;
  const stopLooking = () => {
    clearTimeout(lookTimer);
    isLooking = false;
  };

  const handleLookForMore = async () => {
    if (isLooking) {
      return;
    }

    isLooking = true;
    try {
      await refreshPersonSuggestions();
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
      stopLooking();
      return;
    }

    // the search runs as a job; check back for a few minutes
    let attempts = 0;
    const check = async (): Promise<void> => {
      attempts++;
      try {
        const { pending } = await getPersonSuggestionStatistics({ personId });
        if (pending > queue.length) {
          await refill();
          stopLooking();
          return;
        }
      } catch {
        // try again next time
      }

      if (attempts < 36 && isLooking) {
        lookTimer = setTimeout(() => void check(), 5000);
      } else {
        stopLooking();
      }
    };
    lookTimer = setTimeout(() => void check(), 3000);
  };

  onDestroy(stopLooking);
</script>

<svelte:document
  use:shortcuts={[
    { shortcut: { key: 'z' }, onShortcut: () => handleUndo() },
    { shortcut: { key: 'z', ctrl: true }, onShortcut: () => handleUndo() },
    { shortcut: { key: 'z', meta: true }, onShortcut: () => handleUndo() },
  ]}
/>

<UserPageLayout title={$t('same_person')} description={total > 0 ? `(${total.toLocaleString($locale)})` : undefined}>
  {#snippet buttons()}
    <div class="flex items-center gap-1">
      <Button
        href={Route.people()}
        size="small"
        variant="ghost"
        color="secondary"
        leadingIcon={mdiArrowLeft}
        class="hidden sm:inline-flex">{$t('people')}</Button
      >
      <Button
        size="small"
        variant="ghost"
        color="secondary"
        leadingIcon={mdiUndo}
        disabled={busy || answers.length === 0}
        onclick={() => handleUndo()}
        data-testid="suggestion-undo"
      >
        {$t('same_person_undo')}
      </Button>
    </div>
  {/snippet}

  <div class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-2 pt-2 pb-8 sm:px-4">
    {#if person}
      <div
        class="flex flex-wrap items-center justify-center gap-2 text-sm text-gray-600 dark:text-gray-400"
        data-testid="suggestion-filter"
      >
        <span>{$t('same_person_about', { values: { name: personName } })}</span>
        <Button href={Route.peopleSuggestions()} size="tiny" variant="outline" color="secondary"
          >{$t('same_person_show_all')}</Button
        >
      </div>
    {/if}
    {#if current}
      <SuggestionQuestion suggestion={current} {busy} onAnswer={handleAnswer} />
      <p class="text-center text-sm text-gray-600 dark:text-gray-400" data-testid="suggestion-left">
        {$t('same_person_questions_left', { values: { count: total } })}
      </p>
    {:else}
      <div
        class="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center"
        data-testid="suggestion-empty"
      >
        <Icon icon={mdiAccountQuestionOutline} size="3.5em" />
        {#if person}
          <p class="text-2xl font-medium">{$t('same_person_no_questions_about', { values: { name: personName } })}</p>
          <div class="flex flex-wrap justify-center gap-2">
            <Button href={Route.viewPerson(person)} variant="outline" color="secondary" leadingIcon={mdiArrowLeft}
              >{$t('same_person_back_to_person', { values: { name: personName } })}</Button
            >
            <Button href={Route.peopleSuggestions()}>{$t('same_person_all_questions')}</Button>
          </div>
        {:else}
          <p class="text-2xl font-medium">{$t('same_person_no_questions')}</p>
          <p class="max-w-md text-sm text-gray-600 dark:text-gray-400">
            {$t('same_person_no_questions_description')}
          </p>
        {/if}
        {#if person}
          <!-- looking for more works out the questions about everyone; the full list is one click away -->
        {:else if isLooking}
          <div class="flex items-center gap-2 text-sm" data-testid="suggestion-looking">
            <LoadingSpinner />
            <span>{$t('same_person_looking')}</span>
          </div>
        {:else}
          <Button leadingIcon={mdiMagnify} onclick={handleLookForMore} data-testid="suggestion-look">
            {$t('same_person_look_for_more')}
          </Button>
        {/if}
      </div>
    {/if}

    {#if answers.length > 0}
      <SuggestionAnswers {answers} {busy} onUndo={handleUndo} />
    {/if}
  </div>
</UserPageLayout>
