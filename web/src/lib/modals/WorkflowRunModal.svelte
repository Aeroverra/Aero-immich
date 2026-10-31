<script lang="ts">
  import { Route } from '$lib/route';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    previewWorkflow,
    runWorkflow,
    type WorkflowPreviewResponseDto,
    type WorkflowResponseDto,
  } from '@immich/sdk';
  import { Alert, FormModal, LoadingSpinner, Text, toastManager, VStack } from '@immich/ui';
  import { mdiPlayCircleOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    workflow: WorkflowResponseDto;
    /** the workflow page has edits that are not saved yet */
    hasChanges?: boolean;
    onClose: (started?: boolean) => void;
  };

  const { workflow, hasChanges = false, onClose }: Props = $props();

  let preview = $state<WorkflowPreviewResponseDto>();
  let isLoading = $state(true);
  let isRunning = $state(false);

  const isEmpty = $derived(!!preview && preview.complete && preview.matched === 0);

  onMount(async () => {
    try {
      preview = await previewWorkflow({ id: workflow.id, limit: 12 });
    } catch (error) {
      handleError(error, $t('errors.unable_to_preview_workflow'));
      onClose();
    } finally {
      isLoading = false;
    }
  });

  const onSubmit = async () => {
    if (isRunning) {
      return;
    }

    isRunning = true;
    try {
      await runWorkflow({ id: workflow.id });
      toastManager.primary($t('workflow_run_started'), { closable: true });
      onClose(true);
    } catch (error) {
      handleError(error, $t('errors.unable_to_run_workflow'));
    } finally {
      isRunning = false;
    }
  };
</script>

<FormModal
  title={$t('workflow_run_existing')}
  icon={mdiPlayCircleOutline}
  {onClose}
  {onSubmit}
  size="medium"
  disabled={isLoading || isRunning || isEmpty}
  submitText={preview?.complete
    ? $t('workflow_run_submit', { values: { count: preview.matched } })
    : $t('workflow_run_submit_all')}
>
  {#if isLoading || !preview}
    <div class="flex flex-col items-center gap-3 py-8" data-testid="workflow-run-loading">
      <LoadingSpinner />
      <Text color="muted">{$t('workflow_run_checking')}</Text>
    </div>
  {:else}
    <VStack gap={4}>
      {#if hasChanges}
        <Alert color="warning" size="small" title={$t('workflow_run_unsaved')} />
      {/if}

      <Text data-testid="workflow-run-summary">
        {#if preview.filters === 0}
          {$t('workflow_run_no_filters', { values: { total: preview.total } })}
        {:else if isEmpty}
          {$t('workflow_run_none')}
        {:else if preview.complete}
          {$t('workflow_run_matches', { values: { matched: preview.matched, total: preview.total } })}
        {:else}
          {$t('workflow_run_matches_partial', {
            values: {
              matched: preview.matched,
              scanned: preview.scanned,
              remaining: preview.total - preview.scanned,
              total: preview.total,
            },
          })}
        {/if}
      </Text>

      {#if preview.assetIds.length > 0}
        <div class="flex flex-col gap-2">
          <Text size="small" fontWeight="medium" color="muted">{$t('workflow_run_sample')}</Text>
          <div class="grid grid-cols-4 gap-1 sm:grid-cols-6">
            {#each preview.assetIds as assetId (assetId)}
              <a
                href={Route.viewAsset({ id: assetId })}
                target="_blank"
                rel="noopener noreferrer"
                class="aspect-square overflow-hidden rounded-md bg-subtle"
              >
                <img
                  src={getAssetMediaUrl({ id: assetId, size: AssetMediaSize.Thumbnail })}
                  alt=""
                  loading="lazy"
                  class="size-full object-cover transition-transform hover:scale-105"
                />
              </a>
            {/each}
          </div>
        </div>
      {/if}

      {#if !isEmpty}
        <Text size="small" color="muted">
          {$t('workflow_run_description')}
          {#if !workflow.logging}
            {$t('workflow_run_logging_hint')}
          {/if}
        </Text>
      {/if}
    </VStack>
  {/if}
</FormModal>
