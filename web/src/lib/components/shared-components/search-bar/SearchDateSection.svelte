<script lang="ts">
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import SearchDateRange from './SearchDateRange.svelte';
</script>

<div>
  <Text fontWeight="medium">{$t('search_filter_date_taken')}</Text>
  <Text class="pb-3" size="small" color="muted">{$t('search_filter_date_description')}</Text>
  <SearchDateRange kind="taken" />
  <Text class="pt-5" fontWeight="medium">{$t('search_filter_date_uploaded')}</Text>
  <Text class="pb-3" size="small" color="muted">{$t('search_filter_date_uploaded_description')}</Text>
  <SearchDateRange kind="uploaded" />
</div>
