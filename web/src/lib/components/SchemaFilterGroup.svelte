<script module lang="ts">
  import { SvelteSet } from 'svelte/reactivity';

  // the filters that are open for editing; kept outside the component, because a dialog opened on top of the step
  // dialog (to pick a filter) renders the step dialog again
  const openFilters = new SvelteSet<unknown>();
</script>

<script lang="ts">
  import SchemaConfiguration from '$lib/components/SchemaConfiguration.svelte';
  import WorkflowFilterGroupSummary from '$lib/components/WorkflowFilterGroupSummary.svelte';
  import { pluginManager } from '$lib/managers/plugin-manager.svelte';
  import PluginMethodPicker from '$lib/modals/PluginMethodPicker.svelte';
  import type { JSONSchemaProperty, SchemaConfig } from '$lib/types';
  import {
    canGroupMethod,
    filterGroupModes,
    formatWorkflowConfigValue,
    getFilterGroupConfig,
    getWorkflowConfigEntries,
    getWorkflowDefaultConfig,
    isFilterGroupSchema,
    type FilterGroupFilter,
    type FilterGroupMode,
  } from '$lib/utils/workflow';
  import { Badge, Button, Icon, IconButton, modalManager, Text } from '@immich/ui';
  import {
    mdiChevronDown,
    mdiChevronUp,
    mdiFilterVariant,
    mdiPlus,
    mdiSwapHorizontal,
    mdiTrashCanOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    /** the key of the group method, its filters come from the same plugin */
    methodKey: string;
    config: SchemaConfig;
  };

  let { methodKey, config = $bindable() }: Props = $props();

  const group = $derived(getFilterGroupConfig(config));

  const setGroup = (changes: { mode?: FilterGroupMode; filters?: FilterGroupFilter[] }) => {
    // read the config again: after a dialog on top, this component may no longer be mounted (see openFilters)
    const { mode, filters } = getFilterGroupConfig(config);
    config = { ...config, mode, filters, ...changes };
  };

  const modeLabels = $derived<Record<FilterGroupMode, string>>({
    any: $t('filter_group_mode_any'),
    all: $t('filter_group_mode_all'),
    none: $t('filter_group_mode_none'),
  });

  const modeDescriptions = $derived<Record<FilterGroupMode, string>>({
    any: $t('filter_group_mode_any_description'),
    all: $t('filter_group_mode_all_description'),
    none: $t('filter_group_mode_none_description'),
  });

  const pickFilter = (selectedKey?: string) =>
    modalManager.show(PluginMethodPicker, {
      title: $t('filter_group_add_filter'),
      selectedKey,
      filter: (method) => canGroupMethod(methodKey, method),
    });

  const getDefaultConfig = (schema: unknown) => (schema ? getWorkflowDefaultConfig(schema as JSONSchemaProperty) : {});

  const toggle = (filter: FilterGroupFilter) => {
    if (openFilters.has(filter)) {
      openFilters.delete(filter);
    } else {
      openFilters.add(filter);
    }
  };

  /** opens the filter at an index, as the config holds it after a change */
  const open = (index: number) => openFilters.add(getFilterGroupConfig(config).filters[index]);

  const onAddFilter = async () => {
    const method = await pickFilter();
    if (method) {
      const filters = [
        ...getFilterGroupConfig(config).filters,
        { method: method.key, config: getDefaultConfig(method.schema) },
      ];
      setGroup({ filters });
      open(filters.length - 1);
    }
  };

  const onChangeFilter = async (index: number) => {
    const method = await pickFilter(group.filters[index]?.method);
    if (method) {
      setGroup({
        filters: getFilterGroupConfig(config).filters.map((filter, i) =>
          i === index ? { method: method.key, config: getDefaultConfig(method.schema) } : filter,
        ),
      });
      open(index);
    }
  };

  const onRemoveFilter = (index: number) => {
    openFilters.delete(group.filters[index]);
    setGroup({ filters: group.filters.filter((_, i) => i !== index) });
  };

  const setFilterConfig = (index: number, value: SchemaConfig) =>
    setGroup({ filters: group.filters.map((filter, i) => (i === index ? { ...filter, config: value } : filter)) });
</script>

<div class="flex flex-col gap-3" data-testid="filter-group">
  <div class="flex flex-col gap-2">
    <Text size="small" fontWeight="medium">{$t('filter_group_match')}</Text>
    <div class="flex w-fit gap-1 rounded-full border border-light-200 bg-light p-1" role="group">
      {#each filterGroupModes as mode (mode)}
        <Button
          variant={group.mode === mode ? 'filled' : 'ghost'}
          color={group.mode === mode ? 'primary' : 'secondary'}
          size="small"
          shape="round"
          aria-pressed={group.mode === mode}
          onclick={() => setGroup({ mode })}
        >
          {modeLabels[mode]}
        </Button>
      {/each}
    </div>
    <Text size="small" color="muted">{modeDescriptions[group.mode]}</Text>
  </div>

  {#if group.filters.length === 0}
    <Text size="small" color="muted" class="rounded-xl border border-dashed border-light-300 p-3">
      {$t('filter_group_empty')}
    </Text>
  {/if}

  {#each group.filters as filter, index (index)}
    {@const method = pluginManager.getMethod(filter.method)}
    {@const isOpen = openFilters.has(filter)}
    {@const isGroup = isFilterGroupSchema(method?.schema)}
    {@const entries = getWorkflowConfigEntries(filter.config)}
    {#if index > 0}
      <Text size="tiny" fontWeight="semi-bold" color="muted" class="ps-3 uppercase">
        {group.mode === 'all' ? $t('filter_group_and') : $t('filter_group_or')}
      </Text>
    {/if}
    <div class="flex flex-col gap-3 rounded-xl border border-light-200 p-3" data-testid="filter-group-filter">
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="flex min-w-0 grow cursor-pointer items-center gap-2 text-start"
          aria-expanded={isOpen}
          onclick={() => toggle(filter)}
        >
          <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-50">
            <Icon icon={mdiFilterVariant} size="18" class="text-primary" />
          </div>
          <div class="flex min-w-0 grow flex-col">
            <Text size="small" fontWeight="medium" class="truncate">{pluginManager.getMethodLabel(filter.method)}</Text>
            {#if isOpen && method?.description}
              <Text size="tiny" color="muted" class="line-clamp-2">{method.description}</Text>
            {/if}
          </div>
          <Icon icon={isOpen ? mdiChevronUp : mdiChevronDown} size="20" class="shrink-0 text-light-500" />
        </button>
        <IconButton
          icon={mdiSwapHorizontal}
          aria-label={$t('change')}
          title={$t('change')}
          variant="ghost"
          shape="round"
          color="secondary"
          size="small"
          class="shrink-0"
          onclick={() => onChangeFilter(index)}
        />
        <IconButton
          icon={mdiTrashCanOutline}
          aria-label={$t('delete')}
          title={$t('delete')}
          variant="ghost"
          shape="round"
          color="danger"
          size="small"
          class="shrink-0"
          onclick={() => onRemoveFilter(index)}
        />
      </div>

      {#if isOpen && method?.schema}
        <div class="flex flex-col gap-4">
          <SchemaConfiguration
            schema={method.schema as JSONSchemaProperty}
            methodKey={filter.method}
            bind:config={() => filter.config, (value) => setFilterConfig(index, value)}
            root
          />
        </div>
      {:else if isGroup}
        <WorkflowFilterGroupSummary config={filter.config} />
      {:else if entries.length > 0}
        <div class="flex flex-wrap items-center gap-1.5">
          {#each entries as [key, value] (key)}
            <Badge color="info" shape="round" size="small" class="max-w-full border border-primary-200 font-mono">
              <span class="opacity-60">{key}</span>{formatWorkflowConfigValue($t, value)}
            </Badge>
          {/each}
        </div>
      {/if}
    </div>
  {/each}

  <Button
    size="small"
    fullWidth
    variant="ghost"
    leadingIcon={mdiPlus}
    class="border border-dashed"
    onclick={onAddFilter}
  >
    {$t('filter_group_add_filter')}
  </Button>
</div>
