<script lang="ts">
  import { getAssetMetadata, type AssetMetadataResponseDto, type AssetResponseDto } from '@immich/sdk';
  import { Icon, Link, Text } from '@immich/ui';
  import { mdiChevronDown, mdiChevronRight, mdiOpenInNew } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
  }

  let { asset, isOwner }: Props = $props();

  // written by importers such as immich-go for Google Photos takeouts
  const googlePhotosKey = 'google-photos';

  let items = $state<AssetMetadataResponseDto[]>([]);
  let expanded = $state(false);

  $effect(() => {
    const id = asset.id;
    items = [];
    if (!isOwner) {
      return;
    }
    getAssetMetadata({ id })
      .then((result) => {
        if (asset.id === id) {
          items = result;
        }
      })
      .catch(() => {
        // metadata is optional, the panel simply stays hidden
      });
  });

  const googlePhotosUrl = $derived.by(() => {
    const url = items.find(({ key }) => key === googlePhotosKey)?.value.url;
    return typeof url === 'string' && url.startsWith('https://photos.google.com/') ? url : undefined;
  });
</script>

{#if items.length > 0}
  <section class="px-4 pt-4 text-sm" data-testid="detail-panel-metadata">
    {#if googlePhotosUrl}
      <Link href={googlePhotosUrl} target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 py-2">
        <Icon icon={mdiOpenInNew} size="18" />
        {$t('open_in_google_photos')}
      </Link>
    {/if}

    <button
      type="button"
      class="flex h-10 w-full items-center gap-1 text-start"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      <Icon icon={expanded ? mdiChevronDown : mdiChevronRight} size="18" />
      <Text color="muted">{$t('asset_metadata')}</Text>
    </button>

    {#if expanded}
      {#each items as item (item.key)}
        <div class="pb-3">
          <Text size="small" fontWeight="semi-bold">{item.key}</Text>
          <pre
            class="mt-1 max-h-96 overflow-auto rounded-lg bg-gray-100 p-2 text-xs break-all whitespace-pre-wrap dark:bg-gray-800">{JSON.stringify(
              item.value,
              null,
              2,
            )}</pre>
        </div>
      {/each}
    {/if}
  </section>
{/if}
