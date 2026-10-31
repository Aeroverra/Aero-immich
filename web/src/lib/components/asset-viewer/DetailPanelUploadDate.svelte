<script lang="ts">
  import { locale } from '$lib/stores/preferences.store';
  import { type AssetResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiCloudUploadOutline } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
  };

  const { asset }: Props = $props();

  // the Google Photos upload time for Google Photos imports, else when the asset reached Immich
  const uploadedAt = $derived(DateTime.fromISO(asset.uploadedAt ?? asset.createdAt).toLocal());
  const addedAt = $derived(DateTime.fromISO(asset.createdAt).toLocal());
  // an import shows both: when it was uploaded to Google Photos and when it reached Immich
  const isImported = $derived(uploadedAt.isValid && addedAt.isValid && !uploadedAt.hasSame(addedAt, 'day'));
</script>

{#if uploadedAt.isValid}
  <div class="flex gap-4 py-4" data-testid="detail-panel-upload-date">
    <div><Icon icon={mdiCloudUploadOutline} size="24" /></div>

    <div>
      <p>{uploadedAt.toLocaleString({ month: 'short', day: 'numeric', year: 'numeric' }, { locale: $locale })}</p>
      <p class="text-sm">
        {$t('uploaded')} · {uploadedAt.toLocaleString(
          { weekday: 'short', hour: 'numeric', minute: '2-digit' },
          { locale: $locale },
        )}
      </p>
      {#if isImported}
        <p class="text-sm opacity-60">
          {$t('added_to_immich_date', {
            values: {
              date: addedAt.toLocaleString({ month: 'short', day: 'numeric', year: 'numeric' }, { locale: $locale }),
            },
          })}
        </p>
      {/if}
    </div>
  </div>
{/if}
