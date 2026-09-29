<script lang="ts">
  import { TakeoutRunStatus, type TakeoutRunDto } from '@immich/sdk';
  import { Button, ProgressBar, Text } from '@immich/ui';
  import { mdiStopCircleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import TakeoutRunPartsTable from '$lib/components/takeouts/TakeoutRunPartsTable.svelte';
  import {
    counterGroupLabel,
    counterGroups,
    counterLabel,
    handleCancelRun,
    progressFraction,
    runPhaseIndex,
    runPhaseLabel,
    runPhases,
    takeoutRunActive,
  } from '$lib/services/takeout.service';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';

  interface Props {
    run: TakeoutRunDto;
    onCancelled?: (run: TakeoutRunDto) => void;
    /** show the per-part read table under the reading block */
    showParts?: boolean;
  }

  let { run, onCancelled, showParts = true }: Props = $props();

  let phases = $derived(runPhases(run));
  let phaseIndex = $derived(runPhaseIndex(run, phases));
  let stats = $derived(run.readStats);
  let fetching = $derived(phases.includes(TakeoutRunStatus.Fetching));

  // nothing left to read (every part read by an earlier run) still fills the bar once reading is over
  let archiveProgress = $derived(
    run.archiveBytesTotal > 0 ? progressFraction(run.archiveBytesRead, run.archiveBytesTotal) : phaseIndex > 0 ? 1 : 0,
  );
  let fetchProgress = $derived(progressFraction(stats.fetchBytesRead, stats.fetchBytesTotal));
  let mediaProgress = $derived(progressFraction(run.bytesDone, run.bytesTotal));

  // Rate and ETA of asset creation come from the change between successive updates; reading and fetching
  // have the server's ETA (readStats.etaSeconds).
  let mediaRate = $state(0);
  let prev = { bytesDone: run.bytesDone, at: Date.now() };

  $effect(() => {
    const now = Date.now();
    const dt = (now - prev.at) / 1000;
    const db = run.bytesDone - prev.bytesDone;
    if (dt > 0.25 && db >= 0) {
      const instant = db / dt;
      mediaRate = mediaRate === 0 ? instant : mediaRate * 0.6 + instant * 0.4;
      prev = { bytesDone: run.bytesDone, at: now };
    }
  });

  let mediaEta = $derived(mediaRate > 0 ? (run.bytesTotal - run.bytesDone) / mediaRate : undefined);

  const formatEta = (seconds: number): string => {
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  let active = $derived(takeoutRunActive(run.status));
  let reading = $derived(run.status === TakeoutRunStatus.Reading);
  let importing = $derived(run.status === TakeoutRunStatus.Importing);

  const cancel = async () => {
    const cancelled = await handleCancelRun($t, run, $locale);
    if (cancelled) {
      onCancelled?.(cancelled);
    }
  };

  const bytes = (value: number) => getByteUnitString(value, $locale);
  const number = (value: number) => value.toLocaleString($locale);

  let tiles = $derived([
    { key: 'found', label: $t('takeout_read_files_found'), value: number(stats.filesFound) },
    { key: 'server', label: $t('takeout_read_server_duplicates'), value: number(stats.serverDuplicatesSkipped) },
    { key: 'local', label: $t('takeout_read_local_duplicates'), value: number(stats.localDuplicatesSkipped) },
    {
      key: 'staged',
      label: $t('takeout_read_staged'),
      value: number(stats.stagedFiles),
      detail: stats.stagedBytes > 0 ? bytes(stats.stagedBytes) : undefined,
    },
    {
      key: 'deferred',
      label: $t('takeout_read_deferred'),
      value: number(stats.deferredFiles),
      detail: stats.deferredBytes > 0 ? bytes(stats.deferredBytes) : undefined,
    },
  ]);

  type CounterGroup = keyof typeof counterGroups;
  const counterValue = (group: CounterGroup, field: string): number =>
    (run.counters[group] as Record<string, number>)[field] ?? 0;
</script>

<div class="flex flex-col gap-4">
  <ol class="flex flex-wrap items-center gap-2" aria-label={$t('status')}>
    {#each phases as phase, index (phase)}
      <li
        class="rounded-full px-3 py-1 text-sm"
        class:bg-primary={index <= phaseIndex}
        class:text-white={index <= phaseIndex}
        class:bg-gray-200={index > phaseIndex}
        class:dark:bg-gray-700={index > phaseIndex}
        aria-current={index === phaseIndex ? 'step' : undefined}
      >
        {runPhaseLabel($t, phase)}
      </li>
    {/each}
  </ol>

  <section class="flex flex-col gap-2" aria-label={$t('takeout_phase_reading')}>
    <div>
      <div class="flex flex-wrap justify-between gap-x-2">
        <Text size="small">{$t('takeout_archive_read')}</Text>
        <Text size="small" color="muted">
          {bytes(run.archiveBytesRead)} / {bytes(run.archiveBytesTotal)}
          {#if reading && stats.etaSeconds !== null}&middot; {formatEta(stats.etaSeconds)}{/if}
        </Text>
      </div>
      <ProgressBar progress={archiveProgress} size="tiny" color="secondary" />
    </div>

    <dl class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" data-testid="read-tiles">
      {#each tiles as tile (tile.key)}
        <div class="rounded-lg border px-3 py-2 dark:border-gray-700">
          <dt><Text size="tiny" color="muted">{tile.label}</Text></dt>
          <dd>
            <Text size="small" class="font-semibold">{tile.value}</Text>
            {#if tile.detail}<Text size="tiny" color="muted">{tile.detail}</Text>{/if}
          </dd>
        </div>
      {/each}
    </dl>

    {#if showParts && stats.parts.length > 0}
      <TakeoutRunPartsTable parts={stats.parts} />
    {/if}
  </section>

  {#if fetching}
    <section aria-label={$t('takeout_phase_fetching')}>
      <div class="flex flex-wrap justify-between gap-x-2">
        <Text size="small">{$t('takeout_phase_fetching')}</Text>
        <Text size="small" color="muted">
          {bytes(stats.fetchBytesRead)} / {bytes(stats.fetchBytesTotal)}
          {#if run.status === TakeoutRunStatus.Fetching && stats.etaSeconds !== null}&middot;
            {formatEta(stats.etaSeconds)}{/if}
        </Text>
      </div>
      <ProgressBar progress={fetchProgress} size="tiny" color="secondary" />
      <Text size="tiny" color="muted">{$t('takeout_fetching_description')}</Text>
    </section>
  {/if}

  <section aria-label={$t('takeout_phase_creating')}>
    <div class="flex flex-wrap justify-between gap-x-2">
      <Text size="small">{$t('takeout_phase_creating')}</Text>
      <Text size="small" color="muted">
        {bytes(run.bytesDone)} / {bytes(run.bytesTotal)}
        {#if importing && mediaRate > 0}&middot; {bytes(mediaRate)}/s{/if}
        {#if importing && mediaEta !== undefined}&middot; {formatEta(mediaEta)}{/if}
      </Text>
    </div>
    <ProgressBar progress={mediaProgress} size="tiny" />
    <Text size="tiny" color="muted">
      {$t('takeout_files_of', {
        values: { done: run.counters.result.uploaded, total: run.counters.result.toUpload },
      })}
    </Text>
  </section>

  {#if run.currentFile && active}
    <Text size="tiny" color="muted" class="break-all">{run.currentFile}</Text>
  {/if}

  {#if stats.crossDevice}
    <Text size="tiny" color="warning">{$t('takeout_cross_device_note')}</Text>
  {/if}

  <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
    {#each Object.entries(counterGroups) as [group, fields] (group)}
      <div class="rounded-lg border p-3 dark:border-gray-700">
        <Text size="small" class="mb-1 font-semibold">{counterGroupLabel($t, group)}</Text>
        <dl class="flex flex-col gap-0.5">
          {#each fields as field (field)}
            {@const value = counterValue(group as CounterGroup, field)}
            {#if value > 0}
              <div class="flex justify-between">
                <dt><Text size="tiny" color="muted">{counterLabel($t, field)}</Text></dt>
                <dd><Text size="tiny">{number(value)}</Text></dd>
              </div>
            {/if}
          {/each}
        </dl>
      </div>
    {/each}
  </div>

  {#if active && run.status !== TakeoutRunStatus.Cancelling}
    <div>
      <Button size="small" color="danger" variant="outline" leadingIcon={mdiStopCircleOutline} onclick={cancel}>
        {$t('takeout_cancel_run')}
      </Button>
    </div>
  {/if}
</div>
