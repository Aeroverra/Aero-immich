<script lang="ts" module>
  import { persisted } from 'svelte-persisted-store';

  // remembered per browser so people who always want to see the fields only open it once
  const expanded = persisted('asset-metadata-expanded', false);
</script>

<script lang="ts">
  import { getCustomFieldGroups, getGooglePhotosUrl, getVisibleMetadata } from '$lib/utils/asset-metadata-utils';
  import { getAssetMetadata, type AssetMetadataResponseDto, type AssetResponseDto } from '@immich/sdk';
  import { Icon, Link, Text } from '@immich/ui';
  import { mdiChevronDown, mdiChevronRight, mdiOpenInNew } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
  }

  let { asset, isOwner }: Props = $props();

  let items = $state<AssetMetadataResponseDto[]>([]);
  let showRaw = $state(false);

  $effect(() => {
    const id = asset.id;
    items = [];
    showRaw = false;
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

  const visibleItems = $derived(getVisibleMetadata(items));
  const groups = $derived(getCustomFieldGroups(items, (key, options) => $t(key, options)));
  const googlePhotosUrl = $derived(getGooglePhotosUrl(items));
</script>

{#if visibleItems.length > 0}
  <section class="px-6 pt-4 text-sm" data-testid="detail-panel-metadata">
    {#if googlePhotosUrl}
      <Link href={googlePhotosUrl} target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 py-2">
        <Icon icon={mdiOpenInNew} size="18" />
        {$t('open_in_google_photos')}
      </Link>
    {/if}

    <button
      type="button"
      class="flex h-10 w-full items-center gap-1 text-start"
      aria-expanded={$expanded}
      onclick={() => ($expanded = !$expanded)}
    >
      <Icon icon={$expanded ? mdiChevronDown : mdiChevronRight} size="18" />
      <Text size="small" color="muted">{$t('asset_metadata')}</Text>
    </button>

    {#if $expanded}
      {#each groups as group (group.key)}
        <div class="pb-2">
          {#if groups.length > 1 || group.key !== 'google-photos'}
            <Text size="small" fontWeight="semi-bold" class="pb-1">{group.title}</Text>
          {/if}
          <dl class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1.5">
            {#each group.rows as row (row.label)}
              <dt class="text-gray-500 dark:text-gray-400">{row.label}</dt>
              <dd class="space-y-1 wrap-break-word">
                {#each row.value as line, index (index)}
                  <p>{line}</p>
                {/each}
              </dd>
            {/each}
          </dl>
        </div>
      {/each}

      <button
        type="button"
        class="py-1 text-xs text-gray-500 hover:text-primary dark:text-gray-400"
        aria-expanded={showRaw}
        onclick={() => (showRaw = !showRaw)}
      >
        {showRaw ? $t('asset_metadata_hide_raw') : $t('asset_metadata_show_raw')}
      </button>

      {#if showRaw}
        {#each visibleItems as item (item.key)}
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
    {/if}
  </section>
{/if}
