<script lang="ts">
  import { getTakeoutRun, TakeoutRunStatus, type TakeoutRunDto } from '@immich/sdk';
  import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Text } from '@immich/ui';
  import { mdiPlay } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import TakeoutRunProgress from '$lib/components/takeouts/TakeoutRunProgress.svelte';
  import TakeoutRunReport from '$lib/components/takeouts/TakeoutRunReport.svelte';
  import TakeoutSettingsForm from '$lib/components/takeouts/TakeoutSettingsForm.svelte';
  import {
    handleResumeRun,
    runStatusLabel,
    takeoutRunActive,
    takeoutRunResumable,
  } from '$lib/services/takeout.service';
  import { websocketEvents } from '$lib/stores/websocket';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let run = $state(data.run);
  let showSettings = $state(false);

  let active = $derived(takeoutRunActive(run.status));
  let resumable = $derived(takeoutRunResumable(run.status));

  let badgeColor = $derived.by((): 'danger' | 'primary' | 'success' | 'secondary' => {
    if (run.status === TakeoutRunStatus.Failed || run.status === TakeoutRunStatus.Cancelled) {
      return 'danger';
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
    {#if resumable}
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

    <Card>
      <CardBody>
        <TakeoutRunProgress {run} onCancelled={(updated) => (run = updated)} />
      </CardBody>
    </Card>

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
        <TakeoutRunReport runId={run.id} />
      </CardBody>
    </Card>
  </div>
</UserPageLayout>
