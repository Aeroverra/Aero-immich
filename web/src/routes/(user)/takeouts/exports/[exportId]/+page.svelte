<script lang="ts">
  import { goto } from '$app/navigation';
  import { getTakeoutExport, TakeoutCompleteness, type TakeoutExportDto, type TakeoutRunDto } from '@immich/sdk';
  import { Badge, Button, Card, CardBody, CardHeader, CardTitle, HStack, modalManager, Text } from '@immich/ui';
  import { mdiPlay, mdiRefresh, mdiTrashCanOutline } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import TakeoutAnalysisPanel from '$lib/components/takeouts/TakeoutAnalysisPanel.svelte';
  import TakeoutPartsTable from '$lib/components/takeouts/TakeoutPartsTable.svelte';
  import { Route } from '$lib/route';
  import {
    analysisReasonLabel,
    completenessColor,
    completenessLabel,
    handleDeleteExportArchives,
    handleRescanExport,
    handleRunImport,
    runStatusLabel,
    takeoutRunActive,
  } from '$lib/services/takeout.service';
  import { locale } from '$lib/stores/preferences.store';
  import { websocketEvents } from '$lib/stores/websocket';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let detail = $state(data.takeoutExport);

  let complete = $derived(detail.completeness === TakeoutCompleteness.Complete);
  let hasActiveRun = $derived(!!detail.lastRun && takeoutRunActive(detail.lastRun.status));

  const refresh = async () => {
    detail = await getTakeoutExport({ id: detail.id });
  };

  const runImport = async (importAnyway: boolean) => {
    if (importAnyway) {
      const confirmed = await modalManager.showDialog({
        title: $t('takeout_import_anyway'),
        prompt:
          $t('takeout_import_anyway_description') +
          (detail.analysis.reasons.length > 0
            ? '\n\n' + detail.analysis.reasons.map((r) => analysisReasonLabel($t, r)).join('\n')
            : ''),
        confirmText: $t('takeout_import_anyway'),
      });
      if (!confirmed) {
        return;
      }
    }

    const run = await handleRunImport($t, detail.id, importAnyway);
    if (run) {
      await goto(Route.viewTakeoutRun({ id: run.id }));
    }
  };

  const rescan = async () => {
    const updated = await handleRescanExport($t, detail.id);
    if (updated) {
      detail = updated;
    }
  };

  const deleteArchives = async () => {
    if (await handleDeleteExportArchives($t, detail.id)) {
      await refresh();
    }
  };

  onMount(() => {
    const offExport = websocketEvents.on('on_takeout_export', (updated: TakeoutExportDto) => {
      if (updated.id === detail.id) {
        void refresh();
      }
    });
    const offRun = websocketEvents.on('on_takeout_run', (run: TakeoutRunDto) => {
      if (run.exportId === detail.id) {
        void refresh();
      }
    });

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      offExport();
      offRun();
      document.removeEventListener('visibilitychange', onVisible);
    };
  });
</script>

<UserPageLayout title={data.meta.title}>
  {#snippet buttons()}
    <HStack gap={0}>
      {#if complete}
        <Button
          size="small"
          variant="ghost"
          color="secondary"
          leadingIcon={mdiPlay}
          disabled={hasActiveRun}
          onclick={() => runImport(false)}
        >
          <Text class="hidden md:block">{$t('takeout_run_import')}</Text>
        </Button>
      {:else}
        <Button
          size="small"
          variant="ghost"
          color="warning"
          leadingIcon={mdiPlay}
          disabled={hasActiveRun}
          onclick={() => runImport(true)}
        >
          <Text class="hidden md:block">{$t('takeout_import_anyway')}</Text>
        </Button>
      {/if}
      {#if !detail.archivesDeletedAt}
        <Button size="small" variant="ghost" color="danger" leadingIcon={mdiTrashCanOutline} onclick={deleteArchives}>
          <Text class="hidden md:block">{$t('takeout_delete_archives')}</Text>
        </Button>
      {/if}
    </HStack>
  {/snippet}

  <div class="mx-auto flex w-full max-w-4xl flex-col gap-6">
    <Card>
      <CardBody>
        <div class="flex items-start justify-between gap-2">
          <div>
            <Text class="font-semibold"
              >{DateTime.fromISO(detail.exportedAt).toLocaleString(DateTime.DATE_MED, { locale: $locale })}</Text
            >
            {#if detail.accountEmail}<Text size="small" color="muted" class="block">{detail.accountEmail}</Text>{/if}
          </div>
          <Badge color={completenessColor(detail.completeness)}>{completenessLabel($t, detail.completeness)}</Badge>
        </div>
      </CardBody>
    </Card>

    {#if detail.analysis.reasons.length > 0 || detail.analysis.lastPartMayBeMissing}
      <Card>
        <CardHeader><CardTitle>{$t('takeout_uncertain')}</CardTitle></CardHeader>
        <CardBody><TakeoutAnalysisPanel analysis={detail.analysis} /></CardBody>
      </Card>
    {/if}

    <Card>
      <CardHeader>
        <HStack class="w-full justify-between">
          <CardTitle
            >{$t('takeout_parts_found', {
              values: { found: detail.partCount, expected: detail.indexFileCount ?? detail.partCount },
            })}</CardTitle
          >
          <Button size="tiny" variant="ghost" color="secondary" leadingIcon={mdiRefresh} onclick={rescan}
            >{$t('takeout_rescan_failed_parts')}</Button
          >
        </HStack>
      </CardHeader>
      <CardBody>
        <TakeoutPartsTable
          parts={detail.parts}
          missingParts={detail.analysis.missingParts}
          smallParts={detail.analysis.smallParts}
          corruptParts={detail.analysis.corruptParts}
          onRescan={rescan}
        />
      </CardBody>
    </Card>

    {#if detail.runs.length > 0}
      <Card>
        <CardHeader><CardTitle>{$t('takeout_new_run')}</CardTitle></CardHeader>
        <CardBody>
          <ul class="flex flex-col gap-1">
            {#each detail.runs as run (run.id)}
              <li>
                <button
                  type="button"
                  class="flex w-full items-center justify-between rounded-lg px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-800"
                  onclick={() => goto(Route.viewTakeoutRun({ id: run.id }))}
                >
                  <Text size="small"
                    >{DateTime.fromISO(run.createdAt).toLocaleString(DateTime.DATETIME_MED, { locale: $locale })}</Text
                  >
                  <Text size="small" color="muted">{runStatusLabel($t, run.status)}</Text>
                </button>
              </li>
            {/each}
          </ul>
        </CardBody>
      </Card>
    {/if}
  </div>
</UserPageLayout>
