<script lang="ts">
  import { AssetMediaSize, type AssetResponseDto, type TakeoutLargerVersionDto } from '@immich/sdk';
  import { Icon, Text } from '@immich/ui';
  import { mdiCalendar, mdiFileOutline, mdiImageSizeSelectActual, mdiRenameOutline } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';
  import InfoRow from '../../../routes/(user)/utilities/duplicates/[[photos=photos]]/[[assetId=id]]/InfoRow.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';

  interface Props {
    item: TakeoutLargerVersionDto;
  }

  let { item }: Props = $props();

  const thumbnailUrl = (asset: AssetResponseDto): string =>
    getAssetMediaUrl({ id: asset.id, cacheKey: asset.thumbhash, size: AssetMediaSize.Thumbnail });

  const resolution = (asset: AssetResponseDto): string | undefined => {
    const width = asset.exifInfo?.exifImageWidth;
    const height = asset.exifInfo?.exifImageHeight;
    return width && height ? `${width} x ${height}` : undefined;
  };

  const fileSize = (asset: AssetResponseDto): string | undefined =>
    asset.exifInfo?.fileSizeInByte ? getByteUnitString(asset.exifInfo.fileSizeInByte, $locale) : undefined;

  const dateTaken = (asset: AssetResponseDto): string =>
    DateTime.fromISO(asset.localDateTime ?? asset.fileCreatedAt).toLocaleString(DateTime.DATETIME_MED, {
      locale: $locale,
    });
</script>

<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
  {#snippet column(asset: AssetResponseDto, heading: string)}
    <div class="rounded-lg border p-3 dark:border-gray-700">
      <Text size="small" class="mb-2 font-semibold">{heading}</Text>
      <img
        src={thumbnailUrl(asset)}
        alt={asset.originalFileName}
        class="mb-2 max-h-72 w-full rounded-sm object-contain"
      />
      <InfoRow icon={mdiRenameOutline} title={$t('name')}>{asset.originalFileName}</InfoRow>
      {#if resolution(asset)}
        <InfoRow icon={mdiImageSizeSelectActual} title={$t('size')}>{resolution(asset)}</InfoRow>
      {/if}
      {#if fileSize(asset)}
        <InfoRow icon={mdiFileOutline} title={$t('file_size')}>{fileSize(asset)}</InfoRow>
      {/if}
      <InfoRow icon={mdiCalendar} title={$t('date_and_time')} borderBottom={false}>{dateTaken(asset)}</InfoRow>
    </div>
  {/snippet}

  {@render column(item.larger, $t('takeout_larger_version_larger_heading'))}

  {#if item.smaller}
    {@render column(item.smaller, $t('takeout_larger_version_smaller_heading'))}
  {:else}
    <div class="flex items-center justify-center rounded-lg border p-3 dark:border-gray-700">
      <div class="flex flex-col items-center gap-2 text-center">
        <Icon icon={mdiFileOutline} size="32" class="text-immich-fg/30" />
        <Text color="muted">{$t('takeout_larger_version_smaller_deleted')}</Text>
      </div>
    </div>
  {/if}
</div>
