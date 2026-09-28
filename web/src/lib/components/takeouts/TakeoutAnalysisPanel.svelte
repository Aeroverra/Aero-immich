<script lang="ts">
  import type { TakeoutAnalysisDto, TakeoutPathSampleDto } from '@immich/sdk';
  import { Icon, Text } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiChevronDown, mdiChevronRight } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { analysisReasonLabel } from '$lib/services/takeout.service';

  interface Props {
    analysis: TakeoutAnalysisDto;
  }

  let { analysis }: Props = $props();

  let expanded = $state<Record<string, boolean>>({});
  const toggle = (key: string) => (expanded[key] = !expanded[key]);

  let samples = $derived<{ key: string; label: string; data: TakeoutPathSampleDto }[]>([
    {
      key: 'index_missing',
      label: $t('takeout_index_missing_files', { values: { count: analysis.indexMissingFiles.count } }),
      data: analysis.indexMissingFiles,
    },
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

<div class="flex flex-col gap-3">
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

  {#if analysis.lastPartMayBeMissing}
    <Text size="small" color="warning">{$t('takeout_last_part_may_be_missing')}</Text>
  {/if}

  {#each samples as sample (sample.key)}
    {#if sample.data.count > 0}
      <div class="rounded-lg border p-2 dark:border-gray-700">
        <button type="button" class="flex w-full items-center gap-1 text-left" onclick={() => toggle(sample.key)}>
          <Icon icon={expanded[sample.key] ? mdiChevronDown : mdiChevronRight} size="16" />
          <Text size="small">{sample.label}</Text>
        </button>
        {#if expanded[sample.key]}
          <ul class="mt-1 max-h-64 overflow-y-auto pl-5">
            {#each sample.data.sample as path (path)}
              <li class="break-all"><Text size="tiny" color="muted">{path}</Text></li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  {/each}

  {#if analysis.notInIndex > 0}
    <Text size="tiny" color="muted">{$t('takeout_index_without_parts')}: {analysis.notInIndex}</Text>
  {/if}
</div>
