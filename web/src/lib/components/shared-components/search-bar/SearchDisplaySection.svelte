<script lang="ts">
  import SearchButton from './SearchButton.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import { Text } from '@immich/ui';
  import { SvelteSet } from 'svelte/reactivity';
  import { t } from 'svelte-i18n';

  let filters = $derived(searchManager.filter.display);
  let hasNoTags = $derived(searchManager.filter.tagIds === null);

  const toggleNoTags = () => {
    searchManager.filter.tagIds = hasNoTags ? new SvelteSet() : null;
  };
</script>

<div id="display-options-selection">
  <fieldset>
    <Text class="py-5" fontWeight="medium">{$t('library')}</Text>
    <div class="flex flex-wrap gap-2">
      <SearchButton checked active={filters.isFavorite} onclick={() => (filters.isFavorite = !filters.isFavorite)}
        >{$t('favorites')}</SearchButton
      >
      <SearchButton checked active={filters.isArchive} onclick={() => (filters.isArchive = !filters.isArchive)}
        >{$t('archive')}</SearchButton
      >
      <SearchButton checked active={filters.isNotInAlbum} onclick={() => (filters.isNotInAlbum = !filters.isNotInAlbum)}
        >{$t('search_filter_display_option_not_in_album')}</SearchButton
      >
      {#if authManager.authenticated && authManager.preferences.tags.enabled}
        <SearchButton checked active={hasNoTags} onclick={toggleNoTags}
          >{$t('search_filter_display_option_no_tags')}</SearchButton
        >
      {/if}
    </div>
  </fieldset>
</div>
