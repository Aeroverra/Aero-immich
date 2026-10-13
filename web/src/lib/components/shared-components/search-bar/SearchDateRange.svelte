<script lang="ts">
  import { getSearchDatePreset, SearchDatePreset } from './search-bar-utils';
  import { DatePicker, Text } from '@immich/ui';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import SearchButton from './SearchButton.svelte';

  interface Props {
    /** which date the range filters: when the photo was taken or when it was uploaded */
    kind: 'taken' | 'uploaded';
  }

  let { kind }: Props = $props();

  const afterKey = $derived(kind === 'taken' ? 'takenAfter' : 'uploadedAfter');
  const beforeKey = $derived(kind === 'taken' ? 'takenBefore' : 'uploadedBefore');

  let filters = $derived(searchManager.filter.date);
  let after = $derived(filters[afterKey]);
  let before = $derived(filters[beforeKey]);
  let invalid = $derived(after && before && after > before);

  let currentPreset = $derived(getSearchDatePreset(after, before));

  const setRange = (start: DateTime | undefined, end: DateTime | undefined) => {
    filters[afterKey] = start;
    filters[beforeKey] = end;
  };

  const setPreset = (preset: SearchDatePreset) => {
    if (currentPreset === preset) {
      setRange(undefined, undefined);
      currentPreset = undefined;
      return;
    }

    switch (preset) {
      case SearchDatePreset.ThisYear: {
        setRange(DateTime.utc().startOf('year'), DateTime.utc().endOf('year'));
        break;
      }
      case SearchDatePreset.LastYear: {
        setRange(DateTime.utc().minus({ years: 1 }).startOf('year'), DateTime.utc().minus({ years: 1 }).endOf('year'));
        break;
      }
      case SearchDatePreset.Last30Days: {
        setRange(DateTime.utc().minus({ days: 30 }).startOf('day'), DateTime.utc().endOf('day'));
        break;
      }
      case SearchDatePreset.Custom: {
        setRange(undefined, undefined);
        break;
      }
    }

    currentPreset = preset;
  };
</script>

<div data-testid="search-date-{kind}">
  <div class="flex flex-wrap gap-2">
    <SearchButton
      checked
      active={currentPreset === SearchDatePreset.ThisYear}
      onclick={() => setPreset(SearchDatePreset.ThisYear)}>{$t('search_filter_date_this_year')}</SearchButton
    >
    <SearchButton
      checked
      active={currentPreset === SearchDatePreset.LastYear}
      onclick={() => setPreset(SearchDatePreset.LastYear)}>{$t('search_filter_date_last_year')}</SearchButton
    >
    <SearchButton
      checked
      active={currentPreset === SearchDatePreset.Last30Days}
      onclick={() => setPreset(SearchDatePreset.Last30Days)}>{$t('search_filter_date_last_30_days')}</SearchButton
    >
    <SearchButton
      checked
      active={currentPreset === SearchDatePreset.Custom}
      onclick={() => setPreset(SearchDatePreset.Custom)}>{$t('search_filter_date_custom')}</SearchButton
    >
  </div>
  {#if currentPreset === SearchDatePreset.Custom}
    <div id="date-range-selection-{kind}" class="grid grid-auto-fit-40 gap-5 py-5">
      <div>
        <Text class="mb-2" fontWeight="medium">{$t('start_date')}</Text>
        <DatePicker bind:value={filters[afterKey]} />
      </div>
      <div>
        <Text class="mb-2" fontWeight="medium">{$t('end_date')}</Text>
        <DatePicker bind:value={filters[beforeKey]} />
      </div>
    </div>
  {/if}
  {#if invalid}
    <Text color="danger">{$t('start_date_before_end_date')}</Text>
  {/if}
</div>
