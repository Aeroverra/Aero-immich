<script lang="ts">
  import { goto } from '$app/navigation';
  import { getTakeoutOverview, type TakeoutExportDto, type TakeoutRunDto } from '@immich/sdk';
  import { Button, Card, CardBody, HStack, Text } from '@immich/ui';
  import { mdiCog, mdiImageMultipleOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import TakeoutExportCard from '$lib/components/takeouts/TakeoutExportCard.svelte';
  import TakeoutFolderCard from '$lib/components/takeouts/TakeoutFolderCard.svelte';
  import TakeoutRunProgress from '$lib/components/takeouts/TakeoutRunProgress.svelte';
  import { TakeoutUploadManager } from '$lib/managers/takeout-upload-manager.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { websocketEvents } from '$lib/stores/websocket';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let overview = $state(data.overview);
  const uploadManager = new TakeoutUploadManager();

  const refresh = async () => {
    overview = await getTakeoutOverview();
  };

  const onExportEvent = (updated: TakeoutExportDto) => {
    const index = overview.exports.findIndex((exp) => exp.id === updated.id);
    if (index === -1) {
      overview.exports = [updated, ...overview.exports];
    } else {
      overview.exports[index] = updated;
    }
  };

  const onRunEvent = (run: TakeoutRunDto) => {
    if (overview.activeRun && overview.activeRun.id === run.id) {
      overview.activeRun = run;
    }
    const exp = overview.exports.find((current) => current.id === run.exportId);
    if (exp) {
      exp.lastRun = run;
    }
  };

  onMount(() => {
    const offExport = websocketEvents.on('on_takeout_export', onExportEvent);
    const offRun = websocketEvents.on('on_takeout_run', onRunEvent);

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
      <Button
        size="small"
        variant="ghost"
        color="secondary"
        leadingIcon={mdiImageMultipleOutline}
        onclick={() => goto(Route.takeoutLargerVersions())}
      >
        <Text class="hidden md:block">{$t('takeout_larger_versions')}</Text>
      </Button>
      <Button
        size="small"
        variant="ghost"
        color="secondary"
        leadingIcon={mdiCog}
        onclick={() => goto(Route.takeoutSettings())}
      >
        <Text class="hidden md:block">{$t('takeout_settings')}</Text>
      </Button>
    </HStack>
  {/snippet}

  <div class="mx-auto flex w-full max-w-4xl flex-col gap-6">
    <TakeoutFolderCard folder={overview.folder} uploads={overview.uploads} manager={uploadManager} />

    {#if overview.activeRun}
      <Card>
        <CardBody>
          <div class="mb-3 flex items-center justify-between">
            <Text class="font-semibold">{$t('takeout_run_import')}</Text>
            <Button
              size="small"
              variant="outline"
              color="secondary"
              onclick={() => goto(Route.viewTakeoutRun({ id: overview.activeRun!.id }))}
            >
              {$t('open')}
            </Button>
          </div>
          <!-- the per-part table lives on the run page -->
          <TakeoutRunProgress run={overview.activeRun} onCancelled={onRunEvent} showParts={false} />
        </CardBody>
      </Card>
    {/if}

    {#if overview.pendingLargerVersions > 0}
      <Card class="cursor-pointer transition-colors hover:border-primary">
        <CardBody>
          <button type="button" class="w-full text-left" onclick={() => goto(Route.takeoutLargerVersions())}>
            <Text>{$t('takeout_larger_versions')}: {overview.pendingLargerVersions.toLocaleString($locale)}</Text>
          </button>
        </CardBody>
      </Card>
    {/if}

    {#if overview.exports.length > 0}
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        {#each overview.exports as exp (exp.id)}
          <TakeoutExportCard {exp} onRun={refresh} />
        {/each}
      </div>
    {:else}
      <Text color="muted" class="text-center"
        >{$t('takeout_folder_description', { values: { name: overview.folder.name } })}</Text
      >
    {/if}

    {#if overview.otherFiles.length > 0}
      <Card>
        <CardBody>
          <Text class="mb-2 font-semibold">{$t('takeout_other_files')}</Text>
          <ul class="flex flex-col gap-1">
            {#each overview.otherFiles as file (file.name)}
              <li class="flex justify-between">
                <Text size="small" class="break-all">{file.name}</Text>
                <Text size="small" color="muted">{getByteUnitString(file.size, $locale)}</Text>
              </li>
            {/each}
          </ul>
        </CardBody>
      </Card>
    {/if}
  </div>
</UserPageLayout>
