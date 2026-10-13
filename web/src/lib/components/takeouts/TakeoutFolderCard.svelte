<script lang="ts">
  import type { TakeoutFolderDto, TakeoutUploadDto } from '@immich/sdk';
  import { Button, Card, CardBody, CardHeader, CardTitle, Code, HStack, ProgressBar, Stack, Text } from '@immich/ui';
  import { mdiClose, mdiDelete, mdiPause, mdiPlay, mdiUploadOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { TakeoutUploadManager } from '$lib/managers/takeout-upload-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { openFilePicker } from '$lib/utils/file-uploader';

  interface Props {
    folder: TakeoutFolderDto;
    uploads: TakeoutUploadDto[];
    manager: TakeoutUploadManager;
  }

  let { folder, uploads, manager }: Props = $props();

  $effect(() => {
    manager.syncFromServer(uploads);
  });

  const handlePick = async () => {
    const files = await openFilePicker({ multiple: true, extensions: ['.zip', '.tgz', '.gz'] });
    if (files.length > 0) {
      await manager.add([...files]);
    }
  };
</script>

<Card>
  <CardHeader>
    <HStack class="w-full justify-between">
      <CardTitle>{folder.name}</CardTitle>
      <Button leadingIcon={mdiUploadOutline} size="small" onclick={handlePick}>
        {$t('takeout_upload_archives')}
      </Button>
    </HStack>
  </CardHeader>
  <CardBody>
    <Text size="small" color="muted">
      {$t('takeout_folder_description', { values: { name: folder.name } })}
    </Text>
    <Code class="mt-1 block">UPLOAD_LOCATION/{folder.hostPath}</Code>

    {#if manager.items.length > 0}
      <Stack gap={2} class="mt-4">
        {#each manager.items as item (item.fileName)}
          <div class="rounded-lg border p-3 dark:border-gray-700">
            <div class="flex items-center justify-between gap-2">
              <Text size="small" class="truncate">{item.fileName}</Text>
              <HStack gap={1}>
                {#if item.status === 'uploading' || item.status === 'queued'}
                  <Button
                    size="tiny"
                    variant="ghost"
                    color="secondary"
                    leadingIcon={mdiPause}
                    onclick={() => manager.pause(item)}
                  >
                    {$t('pause')}
                  </Button>
                {:else if item.status === 'paused' || item.status === 'error'}
                  <Button
                    size="tiny"
                    variant="ghost"
                    color="secondary"
                    leadingIcon={mdiPlay}
                    disabled={!item.file}
                    onclick={() => manager.resume(item)}
                  >
                    {$t('resume')}
                  </Button>
                {/if}
                <Button
                  size="tiny"
                  variant="ghost"
                  color="danger"
                  leadingIcon={item.stale && !item.file ? mdiDelete : mdiClose}
                  onclick={() => manager.cancel(item)}
                >
                  {item.stale && !item.file ? $t('delete') : $t('cancel')}
                </Button>
              </HStack>
            </div>

            <ProgressBar progress={item.progress} size="tiny" class="mt-2" />

            <div class="mt-1 flex justify-between">
              <Text size="tiny" color="muted">
                {getByteUnitString(item.offset, $locale)} / {getByteUnitString(item.size, $locale)}
              </Text>
              {#if item.status === 'paused' && !item.file}
                <Text size="tiny" color="muted">{$t('takeout_upload_resume_hint')}</Text>
              {:else if item.status === 'error'}
                <Text size="tiny" color="danger">{item.error}</Text>
              {:else if item.stale}
                <Text size="tiny" color="warning">{$t('takeout_upload_stale')}</Text>
              {/if}
            </div>
          </div>
        {/each}
      </Stack>
    {/if}
  </CardBody>
</Card>
