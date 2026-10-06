<script lang="ts">
  import { shortcuts } from '$lib/actions/shortcut';
  import SuggestionSide from './SuggestionSide.svelte';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import {
    PersonSuggestionAnswer,
    searchPerson,
    type PersonResponseDto,
    type PersonSuggestionResponseDto,
  } from '@immich/sdk';
  import { Button, Input } from '@immich/ui';
  import { mdiCheck, mdiClose, mdiHelp } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    suggestion: PersonSuggestionResponseDto;
    busy?: boolean;
    /** answer the question; `existing` is a person the merged person should go into, chosen by name */
    onAnswer: (answer: PersonSuggestionAnswer, name?: string, existing?: PersonResponseDto) => void;
  }

  let { suggestion, busy = false, onAnswer }: Props = $props();

  let isNaming = $state(false);
  let name = $state('');
  let existing = $state<PersonResponseDto>();

  // the key hint takes the colour of its button, so it reads on filled and outlined buttons alike
  const keyClass =
    'ms-1 hidden rounded border border-current px-1 font-mono text-xs leading-4 opacity-75 sm:inline-block';

  const targetName = $derived(suggestion.target.person?.name ?? '');
  const isFace = $derived(!suggestion.candidate.person);
  const question = $derived(
    targetName
      ? $t('same_person_question_named', { values: { name: targetName } })
      : $t('same_person_question_unnamed'),
  );

  const answer = (value: PersonSuggestionAnswer) => {
    if (busy || isNaming) {
      return;
    }

    // two unnamed people turning out to be one is a good moment to name them
    if (value === PersonSuggestionAnswer.Same && !targetName) {
      isNaming = true;
      return;
    }

    onAnswer(value);
  };

  const saveName = () => {
    const trimmed = name.trim();
    isNaming = false;
    onAnswer(PersonSuggestionAnswer.Same, trimmed || undefined, trimmed ? existing : undefined);
  };

  const cancelNaming = () => {
    isNaming = false;
    name = '';
    existing = undefined;
  };

  let lookup = 0;
  const findExisting = async (value: string) => {
    const id = ++lookup;
    const normalized = normalizeSearchString(value.trim());
    if (!normalized) {
      existing = undefined;
      return;
    }

    try {
      const people = await searchPerson({ name: value.trim(), withHidden: true });
      if (id === lookup) {
        existing = people.find((person) => person.name && normalizeSearchString(person.name) === normalized);
      }
    } catch {
      existing = undefined;
    }
  };

  // looks the name up once typing pauses
  $effect(() => {
    const value = name;
    const timer = setTimeout(() => void findExisting(value), 250);
    return () => clearTimeout(timer);
  });

  // a new question starts without a name prompt
  $effect(() => {
    if (suggestion.id) {
      cancelNaming();
    }
  });
</script>

<svelte:document
  use:shortcuts={isNaming
    ? []
    : [
        { shortcut: { key: 's' }, onShortcut: () => answer(PersonSuggestionAnswer.Same) },
        { shortcut: { key: 'd' }, onShortcut: () => answer(PersonSuggestionAnswer.Different) },
        { shortcut: { key: 'n' }, onShortcut: () => answer(PersonSuggestionAnswer.Skipped) },
      ]}
/>

<div class="flex flex-col gap-4" data-testid="suggestion-question">
  <h2 class="text-center text-xl font-medium sm:text-2xl" data-testid="suggestion-title">{question}</h2>

  <div class="grid gap-3 md:grid-cols-2 md:gap-4">
    <SuggestionSide
      side={suggestion.candidate}
      title={isFace ? $t('same_person_this_face') : $t('same_person_this_person')}
    />
    <SuggestionSide side={suggestion.target} title={targetName || $t('same_person_unknown')} showPerson />
  </div>

  <div
    class="sticky bottom-0 z-10 -mx-2 flex flex-col items-center gap-3 bg-light/95 px-2 py-3 backdrop-blur-sm md:static md:bg-transparent md:backdrop-blur-none"
  >
    {#if isNaming}
      <form
        class="flex w-full max-w-md flex-col gap-2"
        onsubmit={(event) => {
          event.preventDefault();
          saveName();
        }}
        data-testid="suggestion-name-form"
      >
        <label for="suggestion-name" class="text-center text-sm">{$t('same_person_name_prompt')}</label>
        <Input
          id="suggestion-name"
          bind:value={name}
          placeholder={$t('add_a_name')}
          autofocus
          onkeydown={(event: KeyboardEvent) => {
            if (event.key !== 'Escape') {
              return;
            }

            event.stopPropagation();
            cancelNaming();
          }}
        />
        {#if existing}
          <p class="text-center text-sm text-gray-600 dark:text-gray-400" data-testid="suggestion-name-existing">
            {$t('same_person_merge_into_existing', { values: { name: existing.name } })}
          </p>
        {/if}
        <div class="flex justify-center gap-2">
          <Button type="button" size="small" variant="ghost" color="secondary" onclick={cancelNaming}
            >{$t('cancel')}</Button
          >
          <Button
            type="button"
            size="small"
            variant="outline"
            color="secondary"
            onclick={() => onAnswer(PersonSuggestionAnswer.Same)}>{$t('skip')}</Button
          >
          <Button type="submit" size="small" disabled={!name.trim()}>{$t('same_person_save_name')}</Button>
        </div>
      </form>
    {:else}
      <div class="flex w-full flex-wrap justify-center gap-2 sm:gap-3">
        <Button
          color="secondary"
          leadingIcon={mdiClose}
          disabled={busy}
          onclick={() => answer(PersonSuggestionAnswer.Different)}
          aria-keyshortcuts="d"
          data-testid="suggestion-different"
        >
          {$t('same_person_different')}
          <kbd class={keyClass} aria-hidden="true">D</kbd>
        </Button>
        <Button
          variant="outline"
          color="secondary"
          leadingIcon={mdiHelp}
          disabled={busy}
          onclick={() => answer(PersonSuggestionAnswer.Skipped)}
          aria-keyshortcuts="n"
          data-testid="suggestion-skip"
        >
          {$t('same_person_not_sure')}
          <kbd class={keyClass} aria-hidden="true">N</kbd>
        </Button>
        <Button
          leadingIcon={mdiCheck}
          disabled={busy}
          onclick={() => answer(PersonSuggestionAnswer.Same)}
          aria-keyshortcuts="s"
          data-testid="suggestion-same"
        >
          {$t('same_person_same')}
          <kbd class={keyClass} aria-hidden="true">S</kbd>
        </Button>
      </div>
    {/if}
  </div>
</div>
