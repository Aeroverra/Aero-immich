import { WorkflowTrigger } from '@immich/sdk';
import type { MessageFormatter } from 'svelte-i18n';
import { getTriggerDescription, getTriggerName, getWorkflowDefaultConfig } from '$lib/utils/workflow';

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
