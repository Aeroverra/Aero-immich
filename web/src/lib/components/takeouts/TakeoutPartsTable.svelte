<script lang="ts">
  import { TakeoutScanStatus, type TakeoutMissingPartDto, type TakeoutPartDto } from '@immich/sdk';
  import { Button, Icon, Text } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiRefresh } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';

  interface Props {
    parts: TakeoutPartDto[];
    missingParts?: TakeoutMissingPartDto[];
    smallParts?: string[];
    corruptParts?: string[];
    onRescan?: () => void;
  }

  let { parts, missingParts = [], smallParts = [], corruptParts = [], onRescan }: Props = $props();

  let hasFailed = $derived(parts.some((part) => part.scanStatus === TakeoutScanStatus.Error));
  let smallSet = $derived(new Set(smallParts));
  let corruptSet = $derived(new Set(corruptParts));
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
        {@const isCorrupt = corruptSet.has(part.fileName) || part.scanStatus === TakeoutScanStatus.Error}
        <tr class="border-b" class:text-danger={isCorrupt}>
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
          <td class="py-1 pr-2 whitespace-nowrap">
            {#if isCorrupt}
              <span class="inline-flex items-center gap-1">
                <Icon icon={mdiAlertCircleOutline} size="16" />
                {part.scanError ?? $t('takeout_corrupt_part')}
              </span>
            {:else}
              <Text size="tiny" color="muted">{part.scanStatus}</Text>
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
    {$t('takeout_rescan_failed_parts')}
  </Button>
{/if}
