<script lang="ts">
  import { getTakeoutRun, TakeoutRunStatus, type TakeoutRunDto } from '@immich/sdk';
  import { Badge, Button, Card, CardBody, CardHeader, CardTitle, HStack, Icon, Text } from '@immich/ui';
  import { mdiChevronDown, mdiChevronRight, mdiDeleteOutline, mdiOpenInNew, mdiPlay } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import TakeoutRunPartsTable from '$lib/components/takeouts/TakeoutRunPartsTable.svelte';
  import TakeoutRunProgress from '$lib/components/takeouts/TakeoutRunProgress.svelte';
  import TakeoutRunReport from '$lib/components/takeouts/TakeoutRunReport.svelte';
  import TakeoutSettingsForm from '$lib/components/takeouts/TakeoutSettingsForm.svelte';
  import { Route } from '$lib/route';
  import {
    handleDiscardStaging,
    handleResumeRun,
    runPhaseStatus,
    runStatusLabel,
    stagingExpiresAt,
    takeoutRunActive,
    takeoutRunDiscardable,
    takeoutRunResumable,
  } from '$lib/services/takeout.service';
  import { locale } from '$lib/stores/preferences.store';
  import { websocketEvents } from '$lib/stores/websocket';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // follows the page data (the link to a newer run stays on this route) and takes live updates in between
  let run = $derived(data.run);
  let showSettings = $state(false);
  let showArchiveReads = $state(false);

  let active = $derived(takeoutRunActive(run.status));
  let resumable = $derived(takeoutRunResumable(run));
  let discardable = $derived(takeoutRunDiscardable(run));
  // while the archives are read (or reading is paused), the parts table sits under the reading block; afterwards it
  // folds away
  let readingNow = $derived(
    runPhaseStatus(run) === TakeoutRunStatus.Reading || runPhaseStatus(run) === TakeoutRunStatus.Fetching,
  );

  let stagingText = $derived.by(() => {
    const size = getByteUnitString(run.readStats.stagingBytes, $locale);
    const expires = stagingExpiresAt(run);
    if (!expires) {
      return $t('takeout_staging_held', { values: { size } });
    }
    const date = DateTime.fromISO(expires).toLocaleString(DateTime.DATE_MED, { locale: $locale });
    return $t('takeout_staging_kept', { values: { size, date } });
  });

  let badgeColor = $derived.by((): 'danger' | 'primary' | 'success' | 'secondary' | 'warning' => {
    if (run.status === TakeoutRunStatus.Failed || run.status === TakeoutRunStatus.Cancelled) {
      return 'danger';
    }
    if (run.status === TakeoutRunStatus.Paused) {
      return 'warning';
    }
    if (run.status === TakeoutRunStatus.Completed) {
      return 'success';
    }
    return active ? 'primary' : 'secondary';
  });

  const refresh = async () => {
    run = await getTakeoutRun({ id: run.id });
  };

  const resume = async () => {
    const resumed = await handleResumeRun($t, run.id);
    if (resumed) {
      run = resumed;
    }
  };

  const discard = async () => {
    const discarded = await handleDiscardStaging($t, run, $locale);
    if (discarded) {
      run = discarded;
    }
  };

  onMount(() => {
    const offRun = websocketEvents.on('on_takeout_run', (updated: TakeoutRunDto) => {
      if (updated.id === run.id) {
        run = updated;
      }
    });

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      offRun();
      document.removeEventListener('visibilitychange', onVisible);
    };
  });
</script>

<UserPageLayout title={data.meta.title}>
  {#snippet buttons()}
    {#if resumable && !discardable}
      <Button size="small" variant="ghost" color="secondary" leadingIcon={mdiPlay} onclick={resume}>
        <Text class="hidden md:block">{$t('takeout_resume_run')}</Text>
      </Button>
    {/if}
  {/snippet}

  <div class="mx-auto flex w-full max-w-5xl flex-col gap-6">
    <div class="flex items-center gap-2">
      <Badge color={badgeColor}>{runStatusLabel($t, run.status)}</Badge>
      {#if run.importAnyway}<Text size="small" color="muted">{$t('takeout_import_anyway')}</Text>{/if}
    </div>

    {#if run.error}
      <Card><CardBody><Text color="danger">{run.error}</Text></CardBody></Card>
    {/if}

    {#if run.supersededBy}
      <Card>
        <CardBody>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <Text>{$t('takeout_run_superseded')}</Text>
            <Button
              size="small"
              variant="outline"
              color="secondary"
              leadingIcon={mdiOpenInNew}
              href={Route.viewTakeoutRun({ id: run.supersededBy })}
            >
              {$t('open')}
            </Button>
          </div>
        </CardBody>
      </Card>
    {:else if discardable}
      <Card>
        <CardBody>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <Text data-testid="takeout-staging-kept">{stagingText}</Text>
            <HStack gap={2}>
              <Button size="small" color="secondary" leadingIcon={mdiPlay} onclick={resume}>
                {$t('takeout_resume_run')}
              </Button>
              <Button size="small" variant="outline" color="danger" leadingIcon={mdiDeleteOutline} onclick={discard}>
                {$t('takeout_discard_staging')}
              </Button>
            </HStack>
          </div>
        </CardBody>
      </Card>
    {/if}

    <Card>
      <CardBody>
        {#key run.id}
          <TakeoutRunProgress
            {run}
            showParts={readingNow}
            onCancelled={(updated) => (run = updated)}
            onUpdated={(updated) => (run = updated)}
          />
        {/key}
      </CardBody>
    </Card>

    {#if !readingNow && run.readStats.parts.length > 0}
      <Card>
        <CardHeader>
          <button
            type="button"
            class="flex items-center gap-1 text-left"
            aria-expanded={showArchiveReads}
            onclick={() => (showArchiveReads = !showArchiveReads)}
          >
            <Icon icon={showArchiveReads ? mdiChevronDown : mdiChevronRight} size="20" />
            <CardTitle>{$t('takeout_archive_reads')}</CardTitle>
          </button>
        </CardHeader>
        {#if showArchiveReads}
          <CardBody>
            <TakeoutRunPartsTable parts={run.readStats.parts} pausedAt={run.pausedAt} />
          </CardBody>
        {/if}
      </Card>
    {/if}

    <Card>
      <CardHeader>
        <button type="button" class="text-left" onclick={() => (showSettings = !showSettings)}>
          <CardTitle>{$t('takeout_settings')}</CardTitle>
        </button>
      </CardHeader>
      {#if showSettings}
        <CardBody>
          <TakeoutSettingsForm settings={run.settings} readOnly />
        </CardBody>
      {/if}
    </Card>

    <Card>
      <CardHeader><CardTitle>{$t('takeout_download_report')}</CardTitle></CardHeader>
      <CardBody>
        {#key run.id}
          <TakeoutRunReport runId={run.id} />
        {/key}
      </CardBody>
    </Card>
  </div>
</UserPageLayout>
