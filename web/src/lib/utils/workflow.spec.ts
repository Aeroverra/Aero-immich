import { WorkflowTrigger, type PluginMethodResponseDto } from '@immich/sdk';
import type { MessageFormatter } from 'svelte-i18n';
import {
  canGroupMethod,
  formatWorkflowConfigValue,
  getFilterGroupConfig,
  getFilterGroupSummaryLines,
  getTriggerDescription,
  getTriggerName,
  getWorkflowDefaultConfig,
  isFilterGroupSchema,
} from '$lib/utils/workflow';

describe(getWorkflowDefaultConfig.name, () => {
  describe('required properties', () => {
    it('should use a default value', () => {
      expect(
        getWorkflowDefaultConfig({
          type: 'object',
          properties: {
            test: {
              type: 'boolean',
              default: true,
            },
          },
          required: ['test'],
        }),
      ).toEqual({ test: true });
    });

    it('should default to an empty array', () => {
      expect(
        getWorkflowDefaultConfig({
          type: 'object',
          properties: {
            test: {
              type: 'string',
              array: true,
            },
          },
          required: ['test'],
        }),
      ).toEqual({ test: [] });
    });

    it('should default to false', () => {
      expect(
        getWorkflowDefaultConfig({
          type: 'object',
          properties: {
            test: {
              type: 'boolean',
            },
          },
          required: ['test'],
        }),
      ).toEqual({ test: false });
    });

    it('should default to 0 (integer)', () => {
      expect(
        getWorkflowDefaultConfig({
          type: 'object',
          properties: {
            test: {
              type: 'integer',
            },
          },
          required: ['test'],
        }),
      ).toEqual({ test: 0 });
    });

    it('should default to 0 (number)', () => {
      expect(
        getWorkflowDefaultConfig({
          type: 'object',
          properties: {
            test: {
              type: 'number',
            },
          },
          required: ['test'],
        }),
      ).toEqual({ test: 0 });
    });

    it('should default to an empty string', () => {
      expect(
        getWorkflowDefaultConfig({
          type: 'object',
          properties: {
            test: {
              type: 'string',
            },
          },
          required: ['test'],
        }),
      ).toEqual({ test: '' });
    });

    it('should default recursively', () => {
      expect(
        getWorkflowDefaultConfig({
          type: 'object',
          properties: {
            parent: {
              type: 'object',
              properties: {
                test: {
                  type: 'string',
                  array: true,
                },
              },
              required: ['test'],
            },
          },
          required: ['parent'],
        }),
      ).toEqual({ parent: { test: [] } });
    });

    it('should keep going after a property with a default value', () => {
      expect(
        getWorkflowDefaultConfig({
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['any', 'all', 'none'], default: 'any' },
            filters: { type: 'object', array: true },
          },
          required: ['mode', 'filters'],
        }),
      ).toEqual({ mode: 'any', filters: [] });
    });
  });
});

describe('filter groups', () => {
  const groupSchema = { type: 'object', uiHint: { type: 'FilterGroup' }, properties: {} };
  const method = (key: string, uiHints: string[] = ['Filter']) =>
    ({
      key,
      uiHints,
      title: key,
      description: '',
      types: [],
      hostFunctions: false,
    }) as unknown as PluginMethodResponseDto;

  it('should recognize the schema of a group', () => {
    expect(isFilterGroupSchema(groupSchema)).toBe(true);
    expect(isFilterGroupSchema({ type: 'object', properties: {} })).toBe(false);
    expect(isFilterGroupSchema(undefined)).toBe(false);
    expect(isFilterGroupSchema(null)).toBe(false);
  });

  it('should read a group config and fall back to any without filters', () => {
    expect(getFilterGroupConfig({ mode: 'all', filters: [{ method: 'a#b', config: {} }] })).toEqual({
      mode: 'all',
      filters: [{ method: 'a#b', config: {} }],
    });
    expect(getFilterGroupConfig(null)).toEqual({ mode: 'any', filters: [] });
    expect(getFilterGroupConfig({ mode: 'sometimes', filters: 'none' })).toEqual({ mode: 'any', filters: [] });
  });

  it('should only group filters of the same plugin', () => {
    const group = 'immich-plugin-core#assetFilterGroup';
    expect(canGroupMethod(group, method('immich-plugin-core#assetFileFilter'))).toBe(true);
    expect(canGroupMethod(group, method(group))).toBe(true);
    expect(canGroupMethod(group, method('immich-plugin-core#assetFavorite', []))).toBe(false);
    expect(canGroupMethod(group, method('other-plugin#assetFileFilter'))).toBe(false);
  });

  it('should describe nested groups in the summary', () => {
    const config = {
      mode: 'any',
      filters: [
        { method: 'core#file', config: { pattern: 'beach', inverse: null } },
        {
          method: 'core#group',
          config: { mode: 'all', filters: [{ method: 'core#type', config: { allowedTypes: ['VIDEO'] } }] },
        },
      ],
    };

    expect(
      getFilterGroupSummaryLines(config, {
        getLabel: (key) => key.split('#', 2)[1],
        isGroup: (key) => key === 'core#group',
        formatValue: (value) => JSON.stringify(value),
      }),
    ).toEqual(['· file', '    pattern = "beach"', '· group (all)', '    · type', '        allowedTypes = ["VIDEO"]']);
  });

  it('should describe an empty group without lines', () => {
    expect(
      getFilterGroupSummaryLines({ mode: 'none' }, { getLabel: String, isGroup: () => false, formatValue: String }),
    ).toEqual([]);
  });
});

describe(formatWorkflowConfigValue.name, () => {
  const $t = ((key: string, options?: { values?: { count?: number } }) =>
    options?.values?.count === undefined ? key : `${key}:${options.values.count}`) as MessageFormatter;

  it('should format config values for the step cards', () => {
    expect(formatWorkflowConfigValue($t, true)).toBe('on');
    expect(formatWorkflowConfigValue($t, 3)).toBe('3');
    expect(formatWorkflowConfigValue($t, 'a'.repeat(30))).toBe(`"${'a'.repeat(23)}…"`);
    expect(formatWorkflowConfigValue($t, [])).toBe('none');
    expect(formatWorkflowConfigValue($t, ['IMAGE', 'VIDEO'])).toBe('"IMAGE · VIDEO"');
    expect(formatWorkflowConfigValue($t, ['a'.repeat(20), 'b'.repeat(20)])).toBe('items_count:2');
  });
});

describe(getTriggerName.name, () => {
  const $t = ((key: string) => key) as MessageFormatter;

  it('should name every trigger', () => {
    for (const trigger of Object.values(WorkflowTrigger)) {
      expect(getTriggerName($t, trigger)).not.toEqual(trigger);
      expect(getTriggerDescription($t, trigger)).not.toEqual(trigger);
    }
  });

  it('should name the text recognized trigger', () => {
    expect(getTriggerName($t, WorkflowTrigger.AssetOcr)).toEqual('trigger_asset_ocr');
    expect(getTriggerDescription($t, WorkflowTrigger.AssetOcr)).toEqual('trigger_asset_ocr_description');
  });
});
