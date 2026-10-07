import { WorkflowTrigger, type PluginMethodResponseDto } from '@immich/sdk';
import type { MessageFormatter } from 'svelte-i18n';
import type { JSONSchemaProperty, SchemaConfig } from '$lib/types';

export const getTriggerName = ($t: MessageFormatter, type: WorkflowTrigger) => {
  switch (type) {
    case WorkflowTrigger.AssetCreate: {
      return $t('trigger_asset_uploaded');
    }
    // case WorkflowTrigger.PersonRecognized: {
    //   return $t('trigger_person_recognized');
    // }
    case WorkflowTrigger.AssetMetadataExtraction: {
      return $t('trigger_asset_metadata_extraction');
    }
    case WorkflowTrigger.AssetTagged: {
      return $t('trigger_asset_tagged');
    }
    case WorkflowTrigger.AssetOcr: {
      return $t('trigger_asset_ocr');
    }
    default: {
      return type;
    }
  }
};

export const getTriggerDescription = ($t: MessageFormatter, type: WorkflowTrigger) => {
  switch (type) {
    case WorkflowTrigger.AssetCreate: {
      return $t('trigger_asset_uploaded_description');
    }
    // case WorkflowTrigger.PersonRecognized: {
    //   return $t('trigger_person_recognized_description');
    // }
    case WorkflowTrigger.AssetMetadataExtraction: {
      return $t('trigger_asset_metadata_extraction_description');
    }
    case WorkflowTrigger.AssetTagged: {
      return $t('trigger_asset_tagged_description');
    }
    case WorkflowTrigger.AssetOcr: {
      return $t('trigger_asset_ocr_description');
    }
    default: {
      return type;
    }
  }
};

export const getWorkflowDefaultConfig = (schema: JSONSchemaProperty) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = {};

  const requiredProperties = schema.required ?? [];

  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    // default values
    if (property.default) {
      config[key] = property.default;
      continue;
    }

    if (!requiredProperties.includes(key)) {
      continue;
    }

    if (property.array) {
      config[key] = [];
      continue;
    }

    switch (property.type) {
      case 'string': {
        config[key] = '';
        break;
      }

      case 'integer':
      case 'number': {
        config[key] = 0;
        break;
      }

      case 'boolean': {
        config[key] = false;
        break;
      }

      case 'object': {
        config[key] = property.properties ? getWorkflowDefaultConfig(property) : {};
        break;
      }
    }
  }

  return config;
};

export type FilterGroupMode = 'any' | 'all' | 'none';
export type FilterGroupFilter = { method: string; config: SchemaConfig };
export type FilterGroupConfig = { mode: FilterGroupMode; filters: FilterGroupFilter[] };

export const filterGroupModes: FilterGroupMode[] = ['any', 'all', 'none'];

/** a filter group step holds other filter steps in its config, see assetFilterGroup in the core plugin */
export const isFilterGroupSchema = (schema?: unknown) =>
  (schema as JSONSchemaProperty | undefined)?.uiHint?.type === 'FilterGroup';

export const getFilterGroupConfig = (config: SchemaConfig): FilterGroupConfig => {
  const mode = filterGroupModes.includes(config?.mode) ? (config.mode as FilterGroupMode) : 'any';
  const filters = Array.isArray(config?.filters) ? (config.filters as FilterGroupFilter[]) : [];
  return { mode, filters };
};

const getPluginName = (methodKey: string) => methodKey.split('#', 1)[0];

/** a group runs the filters of its own plugin, including other groups */
export const canGroupMethod = (groupMethodKey: string, method: PluginMethodResponseDto) =>
  method.uiHints.includes('Filter') && getPluginName(method.key) === getPluginName(groupMethodKey);

export const truncateWorkflowValue = (input: string, max = 24) =>
  input.length > max ? input.slice(0, max - 1) + '…' : input;

/** a short text for a value of a step configuration, as shown on the step cards */
export const formatWorkflowConfigValue = ($t: MessageFormatter, value: unknown): string => {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return `"${truncateWorkflowValue(value)}"`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return $t('none');
    }
    const items = value.map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)));
    const joined = items.join(' · ');
    if (joined.length <= 28) {
      return `"${joined}"`;
    }
    return $t('items_count', { values: { count: value.length } });
  }
  return JSON.stringify(value);
};

export const getWorkflowConfigEntries = (config: SchemaConfig) =>
  Object.entries((config ?? {}) as Record<string, unknown>).filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  );

/** plain text lines that describe the filters of a group, for the workflow summary */
export const getFilterGroupSummaryLines = (
  config: SchemaConfig,
  options: {
    getLabel: (method: string) => string;
    isGroup: (method: string) => boolean;
    formatValue: (value: unknown) => string;
    indent?: string;
  },
): string[] => {
  const { filters } = getFilterGroupConfig(config);
  const indent = options.indent ?? '';
  const lines: string[] = [];

  for (const filter of filters) {
    if (options.isGroup(filter.method)) {
      const { mode } = getFilterGroupConfig(filter.config);
      lines.push(
        `${indent}· ${options.getLabel(filter.method)} (${mode})`,
        ...getFilterGroupSummaryLines(filter.config, { ...options, indent: `${indent}    ` }),
      );
      continue;
    }

    lines.push(`${indent}· ${options.getLabel(filter.method)}`);
    for (const [key, value] of getWorkflowConfigEntries(filter.config)) {
      lines.push(`${indent}    ${key} = ${options.formatValue(value)}`);
    }
  }

  return lines;
};
