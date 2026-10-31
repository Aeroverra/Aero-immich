<script lang="ts">
  import { TakeoutRunPartStatus, type TakeoutRunPartStatsDto } from '@immich/sdk';
  import { ProgressBar, Text } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { partReadSeconds, progressFraction, readErrorLabel, runPartStatusLabel } from '$lib/services/takeout.service';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';

  interface Props {
    parts: TakeoutRunPartStatsDto[];
    /** when the run was paused, if it is: the speed of a paused part counts until then */
    pausedAt?: string | null;
  }

  let { parts, pausedAt = null }: Props = $props();

  // columns that are almost always zero are shown only when a part needs them
  let showEntryErrors = $derived(parts.some((part) => part.entryErrors > 0));
  let showFetched = $derived(parts.some((part) => part.fetchBytesRead > 0));
  let showRetries = $derived(parts.some((part) => part.transportRetries > 0));

  const statusColor = (status: TakeoutRunPartStatus): 'muted' | 'danger' | 'primary' | 'warning' | undefined => {
    switch (status) {
      case TakeoutRunPartStatus.Error:
      case TakeoutRunPartStatus.Missing: {
        return 'danger';
      }
      case TakeoutRunPartStatus.Reading: {
        return 'primary';
      }
      case TakeoutRunPartStatus.Paused: {
        return 'warning';
      }
      case TakeoutRunPartStatus.Pending:
      case TakeoutRunPartStatus.Cached: {
        return 'muted';
      }
      default: {
        return undefined;
      }
    }
  };

  /** Bytes per second over the time the part was read (until now while it is being read), paused time left out */
  const rate = (part: TakeoutRunPartStatsDto): number | undefined => {
    if (part.bytesRead <= 0) {
      return undefined;
    }
    const seconds = partReadSeconds(part, pausedAt);
    return seconds === undefined ? undefined : part.bytesRead / seconds;
  };

  const passesLabel = (passes: number): string | undefined => {
    if (passes === 2) {
      return $t('takeout_read_twice');
    }
    return passes > 2 ? $t('takeout_read_passes', { values: { count: passes } }) : undefined;
  };

  const count = (value: number): string => (value > 0 ? value.toLocaleString($locale) : '');
</script>

<div class="w-full overflow-x-auto">
  <!-- a minimum width keeps the number columns readable on phones; the wrapper scrolls horizontally -->
  <table class="w-full min-w-3xl text-left text-sm">
    <thead>
      <tr class="border-b text-immich-fg/60 dark:text-immich-dark-fg/60">
        <th class="py-1 pr-2 font-medium">{$t('name')}</th>
        <th class="py-1 pr-2 font-medium">{$t('size')}</th>
        <th class="py-1 pr-2 font-medium">{$t('status')}</th>
        <th class="py-1 pr-2 font-medium">{$t('takeout_read_bytes')}</th>
        <th class="py-1 pr-2 font-medium">{$t('takeout_read_speed')}</th>
        <th class="py-1 pr-2 font-medium">{$t('takeout_read_staged')}</th>
        <th class="py-1 pr-2 font-medium">{$t('duplicates')}</th>
        <th class="py-1 pr-2 font-medium">{$t('takeout_read_deferred')}</th>
        {#if showEntryErrors}<th class="py-1 pr-2 font-medium">{$t('takeout_read_entry_errors')}</th>{/if}
        {#if showFetched}<th class="py-1 pr-2 font-medium">{$t('takeout_read_fetched')}</th>{/if}
        {#if showRetries}<th class="py-1 pr-2 font-medium">{$t('takeout_read_retries')}</th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each parts as part (part.partId)}
        {@const speed = rate(part)}
        {@const passes = passesLabel(part.passes)}
        <tr class="border-b align-top" data-testid="run-part-{part.partId}">
          <td class="py-1 pr-2 break-all">{part.fileName}</td>
          <td class="py-1 pr-2 whitespace-nowrap">{getByteUnitString(part.size, $locale)}</td>
          <td class="py-1 pr-2">
            <Text size="small" color={statusColor(part.status)} class="whitespace-nowrap">
              {runPartStatusLabel($t, part.status)}
            </Text>
            {#if part.status === TakeoutRunPartStatus.Reading || part.status === TakeoutRunPartStatus.Paused}
              <ProgressBar progress={progressFraction(part.position, part.size)} size="tiny" class="mt-1 w-24" />
            {/if}
            {#if part.error}
              <Text size="tiny" color="danger" class="block break-all">{part.error}</Text>
              {#if part.errorOffset !== null}
                <Text size="tiny" color="danger" class="block">{readErrorLabel($t, part.errorOffset, part.size)}</Text>
              {/if}
            {/if}
          </td>
          <td class="py-1 pr-2 whitespace-nowrap">
            {#if part.bytesRead > 0}{getByteUnitString(part.bytesRead, $locale)}{/if}
            {#if passes}<Text size="tiny" color="warning" class="block">{passes}</Text>{/if}
          </td>
          <td class="py-1 pr-2 whitespace-nowrap">
            {#if speed !== undefined}{getByteUnitString(speed, $locale)}/s{/if}
          </td>
          <td class="py-1 pr-2 whitespace-nowrap">
            {count(part.staged)}
            {#if part.stagedBytes > 0}
              <Text size="tiny" color="muted" class="block">{getByteUnitString(part.stagedBytes, $locale)}</Text>
            {/if}
          </td>
          <td class="py-1 pr-2 whitespace-nowrap">{count(part.duplicates)}</td>
          <td class="py-1 pr-2 whitespace-nowrap">{count(part.deferred)}</td>
          {#if showEntryErrors}
            <td class="py-1 pr-2 whitespace-nowrap" class:text-danger={part.entryErrors > 0}
              >{count(part.entryErrors)}</td
            >
          {/if}
          {#if showFetched}
            <td class="py-1 pr-2 whitespace-nowrap">
              {#if part.fetchBytesRead > 0}{getByteUnitString(part.fetchBytesRead, $locale)}{/if}
            </td>
          {/if}
          {#if showRetries}
            <td class="py-1 pr-2 whitespace-nowrap">{count(part.transportRetries)}</td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
