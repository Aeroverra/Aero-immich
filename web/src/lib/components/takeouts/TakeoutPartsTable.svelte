<script lang="ts">
  import { TakeoutPartReadStatus, type TakeoutMissingPartDto, type TakeoutPartDto } from '@immich/sdk';
  import { Button, Icon, Text } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiRefresh } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { partReadStatusLabel, readErrorLabel } from '$lib/services/takeout.service';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';

  interface Props {
    parts: TakeoutPartDto[];
    missingParts?: TakeoutMissingPartDto[];
    smallParts?: string[];
    /** zip parts whose listing could not be read, as "<file name>: <error>" (or the bare file name) */
    corruptParts?: string[];
    onRescan?: () => void;
  }

  let { parts, missingParts = [], smallParts = [], corruptParts = [], onRescan }: Props = $props();

  let hasFailed = $derived(parts.some((part) => part.readStatus === TakeoutPartReadStatus.Error));
  let smallSet = $derived(new Set(smallParts));

  /** The listing error of a part, '' when it failed without a message, undefined when it did not fail */
  const listingError = (fileName: string): string | undefined => {
    for (const entry of corruptParts) {
      if (entry === fileName) {
        return '';
      }
      if (entry.startsWith(`${fileName}: `)) {
        return entry.slice(fileName.length + 2);
      }
    }
  };

  const failed = (status: TakeoutPartReadStatus) =>
    status === TakeoutPartReadStatus.Error || status === TakeoutPartReadStatus.Missing;

  /** Bytes read by the last read of the part and its file count once it was read completely */
  const readSummary = (part: TakeoutPartDto): string =>
    [
      part.bytesRead > 0
        ? $t('takeout_part_bytes_read', { values: { size: getByteUnitString(part.bytesRead, $locale) } })
        : undefined,
      part.entryCount === null ? undefined : $t('takeout_part_entry_count', { values: { count: part.entryCount } }),
    ]
      .filter((value) => value !== undefined)
      .join(' · ');
</script>

<div class="w-full overflow-x-auto">
  <table class="w-full text-left text-sm">
    <thead>
      <tr class="border-b text-immich-fg/60 dark:text-immich-dark-fg/60">
        <th class="py-1 pr-2 font-medium">#</th>
        <th class="py-1 pr-2 font-medium">{$t('name')}</th>
        <th class="py-1 pr-2 font-medium">{$t('size')}</th>
        <th class="py-1 pr-2 font-medium">{$t('status')}</th>
      </tr>
    </thead>
    <tbody>
      {#each parts as part (part.id)}
        {@const isSmall = smallSet.has(part.fileName)}
        {@const listing = listingError(part.fileName)}
        {@const isCorrupt = listing !== undefined || failed(part.readStatus)}
        {@const summary = readSummary(part)}
        <tr class="border-b align-top" class:text-danger={isCorrupt} data-testid="part-{part.id}">
          <td class="py-1 pr-2 whitespace-nowrap"
            >{part.segment === null ? part.partNumber : `${part.segment}-${part.partNumber}`}</td
          >
          <td class="py-1 pr-2 break-all">
            {part.fileName}
            {#if part.isIndex}<Text size="tiny" color="muted" class="ml-1">(index)</Text>{/if}
          </td>
          <td class="py-1 pr-2">
            <span class="whitespace-nowrap">{getByteUnitString(part.size, $locale)}</span>
            {#if isSmall}
              <Text size="tiny" color="muted" class="block">{$t('takeout_small_part')}</Text>
            {/if}
          </td>
          <td class="py-1 pr-2">
            {#if part.readStatus === TakeoutPartReadStatus.Error}
              <span class="inline-flex items-center gap-1 whitespace-nowrap">
                <Icon icon={mdiAlertCircleOutline} size="16" />
                {readErrorLabel($t, part.readErrorOffset, part.size)}
              </span>
              <Text size="tiny" class="block break-all">{part.readError ?? $t('takeout_corrupt_part')}</Text>
            {:else if listing !== undefined}
              <span class="inline-flex items-center gap-1 whitespace-nowrap">
                <Icon icon={mdiAlertCircleOutline} size="16" />
                {$t('takeout_corrupt_part')}
              </span>
              {#if listing}<Text size="tiny" class="block break-all">{listing}</Text>{/if}
            {:else if !part.isIndex || part.readStatus === TakeoutPartReadStatus.Missing}
              <!-- the index part is only parsed for its file list, never read by a run -->
              <Text size="small" color={failed(part.readStatus) ? 'danger' : undefined} class="whitespace-nowrap">
                {partReadStatusLabel($t, part.readStatus)}
              </Text>
            {/if}
            {#if summary}
              <Text size="tiny" color="muted" class="block whitespace-nowrap">{summary}</Text>
            {/if}
          </td>
        </tr>
      {/each}

      {#each missingParts as missing (`${missing.segment}-${missing.partNumber}`)}
        <tr class="border-b text-danger">
          <td class="py-1 pr-2"
            >{missing.segment === null ? missing.partNumber : `${missing.segment}-${missing.partNumber}`}</td
          >
          <td class="py-1 pr-2 break-all" colspan="3">
            <div class="font-medium">{$t('takeout_missing_part')}: {missing.expectedName}</div>
            <Text size="tiny" color="muted">{$t('takeout_missing_part_timestamp_hint')}</Text>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

{#if hasFailed && onRescan}
  <Button class="mt-3" size="small" variant="outline" color="secondary" leadingIcon={mdiRefresh} onclick={onRescan}>
    {$t('takeout_read_failed_parts_again')}
  </Button>
{/if}
