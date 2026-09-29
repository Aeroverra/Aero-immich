<script lang="ts">
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { videoBookmarkManager } from '$lib/managers/video-bookmark-manager.svelte';
  import { formatVideoPosition } from '$lib/utils/people-utils';
  import { AssetTypeEnum, type AssetResponseDto } from '@immich/sdk';
  import { IconButton, Text } from '@immich/ui';
  import { mdiBookmarkPlusOutline, mdiClose, mdiPencil } from '@mdi/js';
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
  };

  const { asset }: Props = $props();

  const isShown = $derived(
    asset.type === AssetTypeEnum.Video && !authManager.isSharedLink && videoBookmarkManager.assetId === asset.id,
  );

  let editingId = $state<string>();
  let draft = $state('');
  let input = $state<HTMLInputElement>();

  const startEditing = async (id: string, label: string) => {
    editingId = id;
    draft = label;
    await tick();
    input?.focus();
    input?.select();
  };

  const save = async () => {
    const id = editingId;
    if (!id) {
      return;
    }
    editingId = undefined;
    await videoBookmarkManager.rename(id, draft);
  };

  const add = async () => {
    const bookmark = await videoBookmarkManager.addAtCurrentPosition(asset.id);
    if (bookmark) {
      await startEditing(bookmark.id, bookmark.label);
    }
  };

  const onKeydown = (event: KeyboardEvent) => {
    // keep the viewer shortcuts (arrows, Escape, b) out of the field
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      void save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      editingId = undefined;
    }
  };
</script>

{#if isShown}
  <section class="px-4 pt-4 text-sm" data-testid="detail-panel-bookmarks">
    <div class="flex h-10 w-full items-center justify-between">
      <Text size="small" color="muted">{$t('video_bookmarks')}</Text>
      <IconButton
        aria-label={$t('add_video_bookmark')}
        title={$t('add_video_bookmark_shortcut')}
        icon={mdiBookmarkPlusOutline}
        size="medium"
        shape="round"
        color="secondary"
        variant="ghost"
        onclick={add}
      />
    </div>

    {#if videoBookmarkManager.bookmarks.length === 0}
      <Text size="small" color="muted" class="pb-2">{$t('no_video_bookmarks')}</Text>
    {:else}
      <ul class="flex flex-col gap-0.5">
        {#each videoBookmarkManager.bookmarks as bookmark (bookmark.id)}
          {@const time = formatVideoPosition(bookmark.time)}
          <li class="flex min-h-9 items-center gap-2 rounded-lg pe-1 hover:bg-subtle dark:hover:bg-immich-dark-gray">
            <button
              type="button"
              class="shrink-0 rounded-full bg-immich-primary/15 px-2 py-0.5 text-xs font-medium text-immich-primary tabular-nums hover:bg-immich-primary/25 dark:bg-immich-dark-primary/15 dark:text-immich-dark-primary"
              title={$t('jump_to_time', { values: { time } })}
              aria-label={$t('jump_to_time', { values: { time } })}
              onclick={() => assetViewerManager.emit('VideoSeek', bookmark.time, true)}
            >
              {time}
            </button>
            {#if editingId === bookmark.id}
              <input
                bind:this={input}
                bind:value={draft}
                type="text"
                maxlength="200"
                class="min-w-0 flex-1 rounded-md border border-gray-300 bg-transparent px-2 py-1 text-sm outline-none focus:border-immich-primary dark:border-gray-600 dark:focus:border-immich-dark-primary"
                placeholder={$t('video_bookmark_label_placeholder')}
                aria-label={$t('video_bookmark_label')}
                onkeydown={onKeydown}
                onblur={save}
              />
            {:else}
              <button
                type="button"
                class="min-w-0 flex-1 truncate py-1 text-start {bookmark.label
                  ? ''
                  : 'text-gray-500 dark:text-gray-400'}"
                title={bookmark.label || $t('jump_to_time', { values: { time } })}
                onclick={() => assetViewerManager.emit('VideoSeek', bookmark.time, true)}
              >
                {bookmark.label || $t('video_bookmark_untitled')}
              </button>
              <IconButton
                aria-label={$t('rename_video_bookmark')}
                icon={mdiPencil}
                size="small"
                shape="round"
                color="secondary"
                variant="ghost"
                onclick={() => startEditing(bookmark.id, bookmark.label)}
              />
            {/if}
            <IconButton
              aria-label={$t('delete_video_bookmark')}
              icon={mdiClose}
              size="small"
              shape="round"
              color="secondary"
              variant="ghost"
              onclick={() => videoBookmarkManager.remove(bookmark.id)}
            />
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}
