<script lang="ts">
  import { TakeoutSizeCheck, type TakeoutAnalysisDto, type TakeoutPathSampleDto } from '@immich/sdk';
  import { Icon, Link, Text } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiCheckCircleOutline, mdiChevronDown, mdiChevronRight } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';
  import { Route } from '$lib/route';
  import { analysisReasonLabel, readErrorLabel, sizeCheckLabel } from '$lib/services/takeout.service';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';

  interface Props {
    analysis: TakeoutAnalysisDto;
  }

  let { analysis }: Props = $props();
  const uid = $props.id();

  let expanded = $state<Record<string, boolean>>({});
  const toggle = (key: string) => (expanded[key] = !expanded[key]);

  type Tone = 'success' | 'warning' | 'danger' | 'muted';
  const icon = (tone: Tone) => (tone === 'success' ? mdiCheckCircleOutline : mdiAlertCircleOutline);

  const sizeTone = (sizeCheck: TakeoutSizeCheck): Tone => {
    switch (sizeCheck) {
      case TakeoutSizeCheck.Ok: {
        return 'success';
      }
      case TakeoutSizeCheck.Low: {
        return 'warning';
      }
      case TakeoutSizeCheck.Short: {
        return 'danger';
      }
      default: {
        return 'muted';
      }
    }
  };

  let unstable = $derived(analysis.reasons.includes('part_unstable'));
  let lastReadAt = $derived(
    analysis.lastReadAt
      ? DateTime.fromISO(analysis.lastReadAt).toLocaleString(DateTime.DATETIME_MED, { locale: $locale })
      : undefined,
  );

  // Before a run the index is checked against the zip listings; after a run, against what the run read.
  let indexSample = $derived({
    key: 'index_missing',
    label: $t('takeout_index_missing_files', { values: { count: analysis.indexMissingFiles.count } }),
    data: analysis.indexMissingFiles,
  });
  let readSamples = $derived<{ key: string; label: string; data: TakeoutPathSampleDto }[]>([
    ...(analysis.listingChecked ? [] : [indexSample]),
    {
      key: 'json_without_media',
      label: $t('takeout_json_without_media', { values: { count: analysis.jsonWithoutMedia.count } }),
      data: analysis.jsonWithoutMedia,
    },
    {
      key: 'media_without_json',
      label: $t('takeout_media_without_json', { values: { count: analysis.mediaWithoutJson.count } }),
      data: analysis.mediaWithoutJson,
    },
  ]);
</script>

{#snippet check(tone: Tone, label: string, detail?: string)}
  <li class="flex items-start gap-2">
    <Icon
      icon={icon(tone)}
      size="16"
      class={tone === 'success'
        ? 'mt-0.5 shrink-0 text-success'
        : tone === 'warning'
          ? 'mt-0.5 shrink-0 text-warning'
          : tone === 'danger'
            ? 'mt-0.5 shrink-0 text-danger'
            : 'mt-0.5 shrink-0 text-gray-500'}
    />
    <div class="min-w-0">
      <Text size="small">{label}</Text>
      {#if detail}<Text size="tiny" color="muted" class="block break-all">{detail}</Text>{/if}
    </div>
  </li>
{/snippet}

{#snippet sample(item: { key: string; label: string; data: TakeoutPathSampleDto })}
  {#if item.data.count > 0}
    <div class="rounded-lg border p-2 dark:border-gray-700">
      <button type="button" class="flex w-full items-center gap-1 text-left" onclick={() => toggle(item.key)}>
        <Icon icon={expanded[item.key] ? mdiChevronDown : mdiChevronRight} size="16" />
        <Text size="small">{item.label}</Text>
      </button>
      {#if expanded[item.key]}
        <ul class="mt-1 max-h-64 overflow-y-auto pl-5">
          {#each item.data.sample as path (path)}
            <li class="break-all"><Text size="tiny" color="muted">{path}</Text></li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet notInIndex()}
  {#if analysis.notInIndex > 0}
    <Text size="tiny" color="muted"
      >{$t('takeout_index_without_parts')}: {analysis.notInIndex.toLocaleString($locale)}</Text
    >
  {/if}
{/snippet}

<div class="flex flex-col gap-4">
  {#if analysis.reasons.length > 0}
    <ul class="flex flex-col gap-1">
      {#each analysis.reasons as reason (reason)}
        <li class="flex items-center gap-2 text-danger">
          <Icon icon={mdiAlertCircleOutline} size="16" />
          <Text size="small">{analysisReasonLabel($t, reason)}</Text>
        </li>
      {/each}
    </ul>
  {/if}

  <section class="flex flex-col gap-2" aria-labelledby="{uid}-before">
    <Text id="{uid}-before" size="small" class="font-semibold">{$t('takeout_before_import')}</Text>
    <ul class="flex flex-col gap-1">
      {#if analysis.missingParts.length === 0}
        {@render check('success', $t('takeout_numbering_complete'))}
      {:else}
        {@render check(
          'danger',
          $t('takeout_numbering_gaps', { values: { count: analysis.missingParts.length } }),
          analysis.missingParts.map((part) => part.expectedName).join(', '),
        )}
      {/if}

      {@render check(
        sizeTone(analysis.sizeCheck),
        sizeCheckLabel($t, analysis.sizeCheck),
        analysis.indexTotalBytes === null
          ? undefined
          : $t('takeout_index_size', {
              values: {
                parts: getByteUnitString(analysis.partsTotalBytes, $locale, 2),
                index: getByteUnitString(analysis.indexTotalBytes, $locale, 2),
              },
            }),
      )}

      {#if analysis.listingChecked}
        {@render check(analysis.indexMissingFiles.count > 0 ? 'danger' : 'success', $t('takeout_listing_checked'))}
      {/if}

      {#if unstable}
        {@render check('warning', $t('takeout_reason_part_unstable'))}
      {/if}

      {#each analysis.corruptParts as corrupt (corrupt)}
        {@render check('danger', $t('takeout_corrupt_part'), corrupt)}
      {/each}
    </ul>

    {#if analysis.listingChecked}
      {@render sample(indexSample)}
      {@render notInIndex()}
    {/if}

    {#if analysis.lastPartMayBeMissing}
      <Text size="small" color="warning">{$t('takeout_last_part_may_be_missing')}</Text>
    {/if}
  </section>

  <section class="flex flex-col gap-2" aria-labelledby="{uid}-last">
    <Text id="{uid}-last" size="small" class="font-semibold">{$t('takeout_from_last_import')}</Text>
    {#if lastReadAt}
      <Text size="tiny" color="muted">
        {#if analysis.lastReadRunId}
          <Link href={Route.viewTakeoutRun({ id: analysis.lastReadRunId })}>
            {$t('takeout_last_read_at', { values: { date: lastReadAt } })}
          </Link>
        {:else}
          {$t('takeout_last_read_at', { values: { date: lastReadAt } })}
        {/if}
      </Text>

      {#if analysis.unreadableParts.length > 0}
        <ul class="flex flex-col gap-1">
          {#each analysis.unreadableParts as part (part.fileName)}
            {@render check('danger', `${part.fileName}: ${readErrorLabel($t, part.offset, part.size)}`, part.error)}
          {/each}
        </ul>
      {/if}

      {#if analysis.unreadableEntries > 0}
        <Text size="small" color="danger">
          {$t('takeout_unreadable_entries', { values: { count: analysis.unreadableEntries } })}
        </Text>
      {/if}

      {#each readSamples as item (item.key)}
        {@render sample(item)}
      {/each}

      {#if !analysis.listingChecked}
        {@render notInIndex()}
      {/if}
    {:else}
      <Text size="small" color="muted">{$t('takeout_not_read_checks')}</Text>
    {/if}
  </section>
</div>
