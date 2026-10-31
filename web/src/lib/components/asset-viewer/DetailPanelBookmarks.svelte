<script lang="ts">
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { videoBookmarkManager } from '$lib/managers/video-bookmark-manager.svelte';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { formatVideoPosition } from '$lib/utils/people-utils';
  import { formatBookmarkTime, parseBookmarkTime } from '$lib/utils/video-bookmark-time';
  import { AssetTypeEnum, type AssetResponseDto } from '@immich/sdk';
  import { IconButton, Text } from '@immich/ui';
  import { mdiBookmarkPlusOutline, mdiCheck, mdiClose, mdiMinus, mdiPencil, mdiPlus } from '@mdi/js';
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
  let timeDraft = $state('');
  let timeInvalid = $state(false);
  let labelInput = $state<HTMLInputElement>();
  let editor = $state<HTMLElement>();

  const editing = $derived(videoBookmarkManager.bookmarks.find((bookmark) => bookmark.id === editingId));

  const startEditing = async (id: string, label: string, time: number) => {
    editingId = id;
    draft = label;
    timeDraft = formatBookmarkTime(time);
    timeInvalid = false;
    await tick();
    labelInput?.focus();
    labelInput?.select();
  };

  const clampTime = (time: number) => {
    const duration = asset.duration ?? 0;
    return Math.min(Math.max(0, time), duration > 0 ? duration : Infinity);
  };

  /** Moves the bookmark and shows the new moment, paused, so it can be checked */
  const moveTo = (time: number) => {
    const id = editingId;
    if (!id) {
      return;
    }
    const next = clampTime(time);
    videoBookmarkManager.setTime(id, next);
    timeDraft = formatBookmarkTime(next);
    timeInvalid = false;
    assetViewerManager.emit('VideoSeek', next);
  };

  const nudge = (deltaMs: number) => {
    if (editing) {
      moveTo(editing.time + deltaMs);
    }
  };

  /** Applies the typed time; leaves the field flagged when the text is not a time */
  const commitTimeDraft = () => {
    if (!editing || timeDraft.trim() === formatBookmarkTime(editing.time)) {
      timeInvalid = false;
      return;
    }
    const time = parseBookmarkTime(timeDraft);
    if (time === undefined) {
      timeInvalid = true;
      return;
    }
    moveTo(time);
  };

  const finish = async () => {
    const id = editingId;
    if (!id) {
      return;
    }
    commitTimeDraft();
    editingId = undefined;
    await videoBookmarkManager.rename(id, draft);
  };

  const cancel = () => {
    editingId = undefined;
  };

  const playFrom = (time: number) => {
    assetViewerManager.emit('VideoSeek', time, true);
    // on a phone the panel covers the video, so get out of the way to watch
    if (mediaQueryManager.maxMd) {
      assetViewerManager.closeDetailPanel();
    }
  };

  const add = async () => {
    const bookmark = await videoBookmarkManager.addAtCurrentPosition(asset.id);
    if (bookmark) {
      await startEditing(bookmark.id, bookmark.label, bookmark.time);
    }
  };

  const onLabelKeydown = (event: KeyboardEvent) => {
    // keep the viewer shortcuts (arrows, Escape, b) out of the field
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      void finish();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  };

  const onTimeKeydown = (event: KeyboardEvent) => {
    event.stopPropagation();
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        const step = event.shiftKey ? 100 : 1000;
        nudge(event.key === 'ArrowUp' ? step : -step);
        break;
      }
      case 'Enter': {
        event.preventDefault();
        commitTimeDraft();
        break;
      }
      case 'Escape': {
        event.preventDefault();
        cancel();
        break;
      }
    }
  };

  const saveLabel = () => {
    if (editingId) {
      void videoBookmarkManager.rename(editingId, draft);
    }
  };

  // a click anywhere outside the editor closes it and keeps what was typed (focus is no guide: Safari does not focus
  // buttons on click)
  $effect(() => {
    if (!editingId) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (editor && !editor.contains(event.target as Node)) {
        void finish();
      }
    };
    addEventListener('pointerdown', onPointerDown, { capture: true });
    return () => removeEventListener('pointerdown', onPointerDown, { capture: true });
  });
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
          {#if editingId === bookmark.id}
            <li
              class="flex flex-col gap-2 rounded-lg bg-subtle p-2 dark:bg-immich-dark-gray"
              data-testid="video-bookmark-editor"
              bind:this={editor}
            >
              <div class="flex items-center gap-1">
                <IconButton
                  aria-label={$t('video_bookmark_earlier')}
                  icon={mdiMinus}
                  size="small"
                  shape="round"
                  color="secondary"
                  variant="ghost"
                  onclick={() => nudge(-1000)}
                />
                <input
                  bind:value={timeDraft}
                  type="text"
                  inputmode="decimal"
                  class="w-20 rounded-md border bg-transparent px-2 py-1 text-center text-sm tabular-nums outline-none {timeInvalid
                    ? 'border-red-500 focus:border-red-500'
                    : 'border-gray-300 focus:border-immich-primary dark:border-gray-600 dark:focus:border-immich-dark-primary'}"
                  aria-label={$t('video_bookmark_time')}
                  aria-invalid={timeInvalid}
                  title={$t('video_bookmark_time_hint')}
                  onkeydown={onTimeKeydown}
                  onblur={commitTimeDraft}
                />
                <IconButton
                  aria-label={$t('video_bookmark_later')}
                  icon={mdiPlus}
                  size="small"
                  shape="round"
                  color="secondary"
                  variant="ghost"
                  onclick={() => nudge(1000)}
                />
                <span class="grow"></span>
                <IconButton
                  aria-label={$t('done')}
                  icon={mdiCheck}
                  size="small"
                  shape="round"
                  color="primary"
                  variant="ghost"
                  onclick={finish}
                />
              </div>
              {#if timeInvalid}
                <Text size="tiny" color="danger">{$t('video_bookmark_time_hint')}</Text>
              {/if}
              <input
                bind:this={labelInput}
                bind:value={draft}
                type="text"
                maxlength="200"
                class="w-full rounded-md border border-gray-300 bg-transparent px-2 py-1 text-sm outline-none focus:border-immich-primary dark:border-gray-600 dark:focus:border-immich-dark-primary"
                placeholder={$t('video_bookmark_label_placeholder')}
                aria-label={$t('video_bookmark_label')}
                onkeydown={onLabelKeydown}
                onblur={saveLabel}
              />
            </li>
          {:else}
            <li class="flex min-h-9 items-center gap-2 rounded-lg pe-1 hover:bg-subtle dark:hover:bg-immich-dark-gray">
              <button
                type="button"
                class="shrink-0 rounded-full bg-immich-primary/15 px-2 py-0.5 text-xs font-medium text-immich-primary tabular-nums hover:bg-immich-primary/25 dark:bg-immich-dark-primary/15 dark:text-immich-dark-primary"
                title={$t('jump_to_time', { values: { time } })}
                aria-label={$t('jump_to_time', { values: { time } })}
                onclick={() => playFrom(bookmark.time)}
              >
                {time}
              </button>
              <button
                type="button"
                class="min-w-0 flex-1 truncate py-1 text-start {bookmark.label
                  ? ''
                  : 'text-gray-500 dark:text-gray-400'}"
                title={bookmark.label || $t('jump_to_time', { values: { time } })}
                onclick={() => playFrom(bookmark.time)}
              >
                {bookmark.label || $t('video_bookmark_untitled')}
              </button>
              <IconButton
                aria-label={$t('edit_video_bookmark')}
                icon={mdiPencil}
                size="small"
                shape="round"
                color="secondary"
                variant="ghost"
                onclick={() => startEditing(bookmark.id, bookmark.label, bookmark.time)}
              />
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
          {/if}
        {/each}
      </ul>
    {/if}
  </section>
{/if}
