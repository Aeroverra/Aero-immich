<script lang="ts">
  import SearchButton from './SearchButton.svelte';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  let isPrivate = $derived(searchManager.filter.isPrivate);
</script>

<div id="private-selection">
  <fieldset>
    <Text class="py-5" fontWeight="medium">{$t('search_private_filter')}</Text>
    <div class="flex flex-wrap gap-2">
      <SearchButton
        checked
        active={isPrivate === undefined}
        onclick={() => (searchManager.filter.isPrivate = undefined)}>{$t('search_private_all')}</SearchButton
      >
      <SearchButton checked active={isPrivate === true} onclick={() => (searchManager.filter.isPrivate = true)}
        >{$t('search_private_only')}</SearchButton
      >
      <SearchButton checked active={isPrivate === false} onclick={() => (searchManager.filter.isPrivate = false)}
        >{$t('search_private_exclude')}</SearchButton
      >
    </div>
  </fieldset>
</div>
