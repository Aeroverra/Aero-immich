<script lang="ts">
  import { TakeoutRunStatus, type TakeoutRunDto } from '@immich/sdk';
  import { Button, ProgressBar, Text } from '@immich/ui';
  import { mdiStopCircleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import {
    counterGroupLabel,
    counterGroups,
    counterLabel,
    handleCancelRun,
    takeoutRunActive,
  } from '$lib/services/takeout.service';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';

  interface Props {
    run: TakeoutRunDto;
    onCancelled?: (run: TakeoutRunDto) => void;
  }

  let { run, onCancelled }: Props = $props();

  const PHASES = [
    TakeoutRunStatus.Scanning,
    TakeoutRunStatus.Planning,
    TakeoutRunStatus.Importing,
    TakeoutRunStatus.Finishing,
  ];
  const PHASE_KEYS = ['scanning', 'planning', 'importing', 'finishing'] as const;

  let phaseIndex = $derived(
    (() => {
      const index = PHASES.indexOf(run.status as (typeof PHASES)[number]);
      if (index !== -1) {
        return index;
      }
      // Finished states light up the whole stepper; queued lights up none.
      return run.status === TakeoutRunStatus.Queued ? -1 : PHASES.length;
    })(),
  );

  let mediaProgress = $derived(run.bytesTotal > 0 ? run.bytesDone / run.bytesTotal : 0);
  let archiveProgress = $derived(run.archiveBytesTotal > 0 ? run.archiveBytesRead / run.archiveBytesTotal : 0);

  // Rate and ETA come from the change between successive updates.
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

  let etaSeconds = $derived(mediaRate > 0 ? (run.bytesTotal - run.bytesDone) / mediaRate : undefined);

  const formatEta = (seconds: number): string => {
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  let active = $derived(takeoutRunActive(run.status));

  const cancel = async () => {
    const cancelled = await handleCancelRun($t, run.id);
    if (cancelled) {
      onCancelled?.(cancelled);
    }
  };

  type CounterGroup = keyof typeof counterGroups;
  const counterValue = (group: CounterGroup, field: string): number =>
    (run.counters[group] as Record<string, number>)[field] ?? 0;
</script>

<div class="flex flex-col gap-4">
  <div class="flex flex-wrap items-center gap-2">
    {#each PHASE_KEYS as phase, index (phase)}
      <div
        class="rounded-full px-3 py-1 text-sm"
        class:bg-primary={index <= phaseIndex}
        class:text-white={index <= phaseIndex}
        class:bg-gray-200={index > phaseIndex}
        class:dark:bg-gray-700={index > phaseIndex}
      >
        {$t(`takeout_phase_${phase}`)}
      </div>
    {/each}
  </div>

  <div>
    <div class="flex justify-between">
      <Text size="small">{$t('takeout_counter_uploaded')}</Text>
      <Text size="small" color="muted">
        {getByteUnitString(run.bytesDone, $locale)} / {getByteUnitString(run.bytesTotal, $locale)}
        {#if mediaRate > 0}&middot; {getByteUnitString(mediaRate, $locale)}/s{/if}
        {#if etaSeconds !== undefined && active}&middot; {formatEta(etaSeconds)}{/if}
      </Text>
    </div>
    <ProgressBar progress={mediaProgress} size="tiny" />
  </div>

  <div>
    <div class="flex justify-between">
      <Text size="small">{$t('takeout_scanning')}</Text>
      <Text size="small" color="muted">
        {getByteUnitString(run.archiveBytesRead, $locale)} / {getByteUnitString(run.archiveBytesTotal, $locale)}
      </Text>
    </div>
    <ProgressBar progress={archiveProgress} size="tiny" color="secondary" />
  </div>

  {#if run.currentFile}
    <Text size="tiny" color="muted" class="break-all">{run.currentFile}</Text>
  {/if}

  {#if run.status === TakeoutRunStatus.Scanning}
    <Text size="tiny" color="muted">{$t('takeout_scans_waiting')}</Text>
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
                <dd><Text size="tiny">{value.toLocaleString($locale)}</Text></dd>
              </div>
            {/if}
          {/each}
        </dl>
      </div>
    {/each}
  </div>

  {#if active}
    <div>
      <Button size="small" color="danger" variant="outline" leadingIcon={mdiStopCircleOutline} onclick={cancel}>
        {$t('takeout_cancel_run')}
      </Button>
    </div>
  {/if}
</div>
