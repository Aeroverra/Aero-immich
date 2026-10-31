<script lang="ts">
  import Combobox, { type ComboBoxOption } from '$lib/components/shared-components/Combobox.svelte';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import { getAllAlbums, type AlbumResponseDto } from '@immich/sdk';
  import { Button, Text } from '@immich/ui';
  import { mdiClose, mdiImageRemoveOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import SearchButton from './SearchButton.svelte';

  interface Props {
    /** the albums to pick from, shared with the filter title */
    albums: AlbumResponseDto[] | undefined;
  }

  let { albums = $bindable() }: Props = $props();

  let container = $state<HTMLDivElement>();
  let selectedAlbums = $derived(searchManager.filter.albumIds);
  let excludedAlbums = $derived(searchManager.filter.excludeAlbumIds);
  let isNotInAlbum = $derived(searchManager.filter.display.isNotInAlbum);
  let allAlbums = $derived(albums ?? []);
  let albumMap = $derived(Object.fromEntries(allAlbums.map((album) => [album.id, album])));
  let options = $derived(
    allAlbums
      .toSorted((a, b) => a.albumName.localeCompare(b.albumName))
      .map((album) => ({ id: album.id, label: album.albumName, value: album.id })),
  );
  let selectedOption = $state(undefined);
  let excludedOption = $state(undefined);

  onMount(() => {
    if (!albums) {
      void getAllAlbums({}).then((result) => (albums = result));
    }
  });

  const handleSelect = (option?: ComboBoxOption) => {
    if (!option?.id) {
      return;
    }

    selectedAlbums.add(option.value);
    excludedAlbums.delete(option.value);
    selectedOption = undefined;
  };

  const handleExclude = (option?: ComboBoxOption) => {
    if (!option?.id) {
      return;
    }

    excludedAlbums.add(option.value);
    selectedAlbums.delete(option.value);
    excludedOption = undefined;
  };

  const handleRemove = (albumIds: Set<string>, albumId: string) => {
    // Move focus back to the container so it doesn't fallback to the body and closes the search bar
    container?.focus();
    albumIds.delete(albumId);
  };

  const handleToggleNotInAlbum = () => {
    searchManager.filter.display.isNotInAlbum = !isNotInAlbum;
  };
</script>

<div id="album-selection" bind:this={container} tabindex="-1">
  <form autocomplete="off" data-testid="search-include-albums">
    <Text class="pb-5">{$t('search_filter_albums_description')}</Text>
    <Combobox
      disabled={isNotInAlbum}
      label={$t('search_include_albums')}
      onSelect={handleSelect}
      defaultFirstOption
      {options}
      bind:selectedOption
      placeholder={$t('search_albums')}
    />
  </form>

  {#if selectedAlbums.size > 0 && !isNotInAlbum}
    <section class="flex flex-wrap gap-2 pt-3">
      {#each selectedAlbums as albumId (albumId)}
        {@const album = albumMap[albumId]}
        {#if album}
          <Button
            size="small"
            shape="round"
            color="primary"
            variant="outline"
            onclick={() => handleRemove(selectedAlbums, albumId)}
            trailingIcon={mdiClose}
            >{album.albumName}
          </Button>
        {/if}
      {/each}
    </section>
  {/if}

  <form autocomplete="off" class="pt-5" data-testid="search-exclude-albums">
    <Combobox
      disabled={isNotInAlbum}
      label={$t('search_exclude_albums')}
      onSelect={handleExclude}
      defaultFirstOption
      {options}
      bind:selectedOption={excludedOption}
      placeholder={$t('search_exclude_albums_placeholder')}
    />
  </form>

  {#if excludedAlbums.size > 0 && !isNotInAlbum}
    <section class="flex flex-wrap gap-2 pt-3">
      {#each excludedAlbums as albumId (albumId)}
        {@const album = albumMap[albumId]}
        {#if album}
          <Button
            size="small"
            shape="round"
            color="danger"
            variant="outline"
            aria-label={$t('search_not_in_album', { values: { album: album.albumName } })}
            onclick={() => handleRemove(excludedAlbums, albumId)}
            leadingIcon={mdiImageRemoveOutline}
            trailingIcon={mdiClose}
            >{album.albumName}
          </Button>
        {/if}
      {/each}
    </section>
  {/if}

  <div class="flex flex-wrap gap-2 pt-5">
    <SearchButton checked active={isNotInAlbum} onclick={handleToggleNotInAlbum}>{$t('not_in_any_album')}</SearchButton>
  </div>
</div>
