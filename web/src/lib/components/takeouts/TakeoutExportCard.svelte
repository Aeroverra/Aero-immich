<script lang="ts">
  import { goto } from '$app/navigation';
  import { TakeoutCompleteness, type TakeoutExportDto, type TakeoutRunDto } from '@immich/sdk';
  import { Badge, Button, Card, CardBody, HStack, ProgressBar, Text } from '@immich/ui';
  import { mdiOpenInNew, mdiPause, mdiPlay } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';
  import { Route } from '$lib/route';
  import {
    completenessColor,
    completenessLabel,
    handlePauseRun,
    handleResumeRun,
    handleRunImport,
    progressFraction,
    runMainProgress,
    runPhaseLabel,
    runStatusLabel,
    takeoutExportChecking,
    takeoutRunActive,
    takeoutRunPausable,
    takeoutRunPaused,
  } from '$lib/services/takeout.service';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';

  interface Props {
    exp: TakeoutExportDto;
    onRun?: () => void;
    /** the run of the export after a pause or a resume */
    onRunChanged?: (run: TakeoutRunDto) => void;
  }

  let { exp, onRun, onRunChanged }: Props = $props();

  let complete = $derived(exp.completeness === TakeoutCompleteness.Complete);
  let checking = $derived(takeoutExportChecking(exp));
  let activeRun = $derived(exp.lastRun && takeoutRunActive(exp.lastRun.status) ? exp.lastRun : undefined);
  let runProgress = $derived(activeRun ? runMainProgress(activeRun) : undefined);
  let paused = $derived(!!activeRun && takeoutRunPaused(activeRun.status));
  let pausable = $derived(!!activeRun && takeoutRunPausable(activeRun.status));
  let busy = $state(false);

  const togglePause = async () => {
    if (!activeRun) {
      return;
    }
    busy = true;
    try {
      const updated = paused ? await handleResumeRun($t, activeRun.id) : await handlePauseRun($t, activeRun.id);
      if (updated) {
        onRunChanged?.(updated);
      }
    } finally {
      busy = false;
    }
  };

  const open = () => goto(Route.viewTakeoutExport({ id: exp.id }));

  const runImport = async () => {
    const run = await handleRunImport($t, exp.id, false);
    if (run) {
      onRun?.();
      await goto(Route.viewTakeoutRun({ id: run.id }));
    }
  };
</script>

<Card class="transition-colors hover:border-primary">
  <CardBody>
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <Text class="font-semibold"
          >{DateTime.fromISO(exp.exportedAt, { zone: 'utc' }).toLocaleString(DateTime.DATE_MED, {
            locale: $locale,
          })}</Text
        >
        {#if exp.accountEmail}
          <Text size="small" color="muted" class="block truncate">{exp.accountEmail}</Text>
        {/if}
      </div>
      <Badge color={completenessColor(exp.completeness)} size="small">
        {checking ? $t('takeout_checking_parts') : completenessLabel($t, exp.completeness)}
      </Badge>
    </div>

    <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      <Text size="small" color="muted">
        {$t('takeout_parts_found', { values: { found: exp.partCount, expected: exp.expectedPartCount } })}
      </Text>
      <Text size="small" color="muted">{getByteUnitString(exp.totalSize, $locale)}</Text>
    </div>

    {#if activeRun}
      <div class="mt-2" data-testid="export-card-run">
        <div class="flex flex-wrap justify-between gap-x-2">
          <Text size="tiny" color={paused ? 'warning' : 'muted'}>
            {#if paused}
              {runStatusLabel($t, activeRun.status)}{#if runProgress}: {runPhaseLabel($t, runProgress.phase)}{/if}
            {:else}
              {runProgress ? runPhaseLabel($t, runProgress.phase) : runStatusLabel($t, activeRun.status)}
            {/if}
          </Text>
          {#if runProgress}
            <Text size="tiny" color="muted">
              {getByteUnitString(runProgress.done, $locale)} / {getByteUnitString(runProgress.total, $locale)}
            </Text>
          {/if}
        </div>
        {#if runProgress}
          <ProgressBar progress={progressFraction(runProgress.done, runProgress.total)} size="tiny" />
        {/if}
      </div>
    {/if}

    <HStack gap={1} class="mt-3">
      <Button size="small" variant="ghost" color="secondary" leadingIcon={mdiOpenInNew} onclick={open}>
        {$t('open')}
      </Button>
      {#if paused || pausable}
        <Button
          size="small"
          variant="ghost"
          color={paused ? 'primary' : 'secondary'}
          leadingIcon={paused ? mdiPlay : mdiPause}
          disabled={busy}
          onclick={togglePause}
        >
          {paused ? $t('takeout_resume_run') : $t('takeout_pause_run')}
        </Button>
      {/if}
      {#if complete}
        <Button size="small" leadingIcon={mdiPlay} disabled={!!activeRun} onclick={runImport}>
          {$t('takeout_run_import')}
        </Button>
      {:else}
        <Button size="small" color="warning" leadingIcon={mdiPlay} disabled={!!activeRun} onclick={open}>
          {$t('takeout_import_anyway')}
        </Button>
      {/if}
    </HStack>
  </CardBody>
</Card>
