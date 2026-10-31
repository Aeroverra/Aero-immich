<script lang="ts">
  import { MediaType } from '$lib/constants';
  import { Field, Input, Text } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import SearchButton from './SearchButton.svelte';
  import { formatVideoLength, parseVideoLength } from './search-bar-utils';

  let filteredMedia = $derived(searchManager.filter.mediaType);

  const toText = (milliseconds?: number) => (milliseconds === undefined ? '' : formatVideoLength(milliseconds));
  let minText = $state(toText(searchManager.filter.minDuration));
  let maxText = $state(toText(searchManager.filter.maxDuration));
  const minLength = $derived(parseVideoLength(minText));
  const maxLength = $derived(parseVideoLength(maxText));

  // a length that does not parse leaves the bound out rather than searching with a wrong one
  $effect(() => {
    searchManager.filter.minDuration = minLength ?? undefined;
    searchManager.filter.maxDuration = maxLength ?? undefined;
  });
</script>

<div id="media-type-selection">
  <fieldset>
    <Text class="pb-5">{$t('media_type_description')}</Text>

    <div class="flex flex-wrap gap-2">
      <SearchButton
        checked
        active={filteredMedia === MediaType.All}
        onclick={() => (searchManager.filter.mediaType = MediaType.All)}
      >
        {$t('all')}
      </SearchButton>
      <SearchButton
        checked
        active={filteredMedia === MediaType.Image}
        onclick={() => (searchManager.filter.mediaType = MediaType.Image)}
      >
        {$t('image')}
      </SearchButton>
      <SearchButton
        checked
        active={filteredMedia === MediaType.Video}
        onclick={() => (searchManager.filter.mediaType = MediaType.Video)}
      >
        {$t('video')}
      </SearchButton>
    </div>
  </fieldset>

  <fieldset class="pt-5" data-testid="search-video-length">
    <Text>{$t('search_video_length')}</Text>
    <Text size="small" color="muted" class="pb-3">{$t('search_video_length_description')}</Text>
    <div class="grid grid-cols-2 gap-3">
      <Field label={$t('search_at_least')} invalid={minLength === null}>
        <Input bind:value={minText} placeholder="0:30" inputmode="numeric" autocomplete="off" />
      </Field>
      <Field label={$t('search_at_most')} invalid={maxLength === null}>
        <Input bind:value={maxText} placeholder="5:00" inputmode="numeric" autocomplete="off" />
      </Field>
    </div>
    {#if minLength === null || maxLength === null}
      <Text size="small" color="danger" class="pt-1">{$t('search_video_length_invalid')}</Text>
    {/if}
  </fieldset>
</div>
