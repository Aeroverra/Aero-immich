<script lang="ts">
  import { pluginManager } from '$lib/managers/plugin-manager.svelte';
  import type { SchemaConfig } from '$lib/types';
  import {
    formatWorkflowConfigValue,
    getFilterGroupConfig,
    getWorkflowConfigEntries,
    isFilterGroupSchema,
  } from '$lib/utils/workflow';
  import { Badge, Text } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import Self from '$lib/components/WorkflowFilterGroupSummary.svelte';

  type Props = {
    config: SchemaConfig;
  };

  let { config }: Props = $props();

  const group = $derived(getFilterGroupConfig(config));
  const title = $derived(
    {
      any: $t('filter_group_summary_any'),
      all: $t('filter_group_summary_all'),
      none: $t('filter_group_summary_none'),
    }[group.mode],
  );
</script>

<div class="flex flex-col gap-2">
  <Text size="small" fontWeight="semi-bold" color="muted">{title}</Text>
  {#if group.filters.length === 0}
    <Text size="small" color="muted">{$t('filter_group_empty')}</Text>
  {/if}
  <ul class="flex flex-col gap-2">
    {#each group.filters as filter, index (index)}
      <li class="flex flex-col gap-1.5 border-l-2 border-primary-200 ps-3">
        {#if isFilterGroupSchema(pluginManager.getMethod(filter.method)?.schema)}
          <Self config={filter.config} />
        {:else}
          {@const entries = getWorkflowConfigEntries(filter.config)}
          <Text size="small" fontWeight="medium">{pluginManager.getMethodLabel(filter.method)}</Text>
          {#if entries.length > 0}
            <div class="flex flex-wrap items-center gap-1.5">
              {#each entries as [key, value] (key)}
                <Badge color="info" shape="round" size="small" class="border border-primary-200 font-mono">
                  <span class="opacity-60">{key}</span>{formatWorkflowConfigValue($t, value)}
                </Badge>
              {/each}
            </div>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
</div>
