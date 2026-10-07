<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { pluginManager } from '$lib/managers/plugin-manager.svelte';
  import { handleCreateWorkflow } from '$lib/services/workflow.service';
  import { handleError } from '$lib/utils/handle-error';
  import { createWorkflow, type PluginTemplateResponseDto, type WorkflowCreateDto } from '@immich/sdk';
  import { Badge, FormModal, Icon, ListButton, Text, toastManager } from '@immich/ui';
  import { mdiCheckCircle, mdiFlashOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { SvelteSet } from 'svelte/reactivity';

  type Props = {
    onClose: () => void;
  };

  const { onClose }: Props = $props();

  // several templates can be picked at once, for example every rule of a pack
  const selectedKeys = new SvelteSet<string>();
  const selected = $derived(pluginManager.templates.filter((template) => selectedKeys.has(template.key)));

  const toDto = (template: PluginTemplateResponseDto): WorkflowCreateDto => ({
    trigger: template.trigger,
    steps: template.steps,
    name: template.title,
    description: template.description,
    enabled: false,
  });

  const onSubmit = async () => {
    if (selected.length === 0) {
      return;
    }

    if (selected.length === 1) {
      const success = await handleCreateWorkflow(toDto(selected[0]));
      if (success) {
        onClose();
      }
      return;
    }

    let created = 0;
    try {
      for (const template of selected) {
        await createWorkflow({ workflowCreateDto: toDto(template) });
        created++;
      }
      toastManager.primary($t('workflows_created', { values: { count: created } }));
      onClose();
    } catch (error) {
      handleError(error, $t('errors.unable_to_create'));
    } finally {
      if (created > 0) {
        await invalidateAll();
      }
    }
  };

  const onToggle = (template: PluginTemplateResponseDto) => {
    if (selectedKeys.has(template.key)) {
      selectedKeys.delete(template.key);
    } else {
      selectedKeys.add(template.key);
    }
  };
</script>

<FormModal
  title={$t('workflow_templates')}
  {onClose}
  {onSubmit}
  disabled={selected.length === 0}
  size="medium"
  submitText={selected.length > 1 ? $t('use_templates', { values: { count: selected.length } }) : $t('use_template')}
>
  <div class="flex flex-col gap-2">
    {#each pluginManager.templates as template (template.key)}
      {@const isSelected = selectedKeys.has(template.key)}
      <ListButton selected={isSelected} onclick={() => onToggle(template)}>
        <div class="flex w-full items-center gap-3 text-start">
          <div
            class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-immich-primary/10 text-immich-primary dark:bg-immich-dark-primary/15 dark:text-immich-dark-primary"
          >
            <Icon icon={isSelected ? mdiCheckCircle : mdiFlashOutline} size="18" />
          </div>
          <div class="min-w-0 grow">
            <Text fontWeight="medium">{template.title}</Text>
            <Text size="tiny" color="muted">{template.description}</Text>
          </div>
          {#if template.uiHints.includes('SmartAlbum')}
            <div class="shrink-0">
              <Badge size="small">{$t('smart_album')}</Badge>
            </div>
          {/if}
        </div>
      </ListButton>
    {/each}
  </div>
</FormModal>
