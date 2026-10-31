<script lang="ts">
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { videoTranscriptManager } from '$lib/managers/video-transcript-manager.svelte';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { formatVideoPosition } from '$lib/utils/people-utils';
  import { filterSegments, getActiveSegmentIndex } from '$lib/utils/video-transcript';
  import { AssetTypeEnum, type AssetResponseDto } from '@immich/sdk';
  import { Icon, Text } from '@immich/ui';
  import { mdiMagnify } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
  };

  const { asset }: Props = $props();

  const isShown = $derived(
    asset.type === AssetTypeEnum.Video &&
      !authManager.isSharedLink &&
      videoTranscriptManager.assetId === asset.id &&
      videoTranscriptManager.segments.length > 0,
  );

  let query = $state('');
  let follow = $state(true);
  let list = $state<HTMLElement>();

  const lines = $derived(filterSegments(videoTranscriptManager.segments, query));
  const activeIndex = $derived(getActiveSegmentIndex(videoTranscriptManager.segments, videoTranscriptManager.position));

  // keeps the spoken line in view inside the list while the video plays, without scrolling the rest of the panel
  $effect(() => {
    if (!follow || !videoTranscriptManager.playing || !list || activeIndex < 0) {
      return;
    }
    const line = list.querySelector<HTMLElement>(`[data-index="${CSS.escape(String(activeIndex))}"]`);
    if (line) {
      list.scrollTo({ top: line.offsetTop - list.clientHeight / 2 + line.clientHeight / 2, behavior: 'smooth' });
    }
  });

  // same as a bookmark: play from the line, and on a phone get the panel out of the way to watch
  const playFrom = (time: number) => {
    assetViewerManager.emit('VideoSeek', time, true);
    if (mediaQueryManager.maxMd) {
      assetViewerManager.closeDetailPanel();
    }
  };

  const onSearchKeydown = (event: KeyboardEvent) => {
    // keep the viewer shortcuts (arrows, space, Escape) out of the field
    event.stopPropagation();
    if (event.key === 'Escape') {
      query = '';
    }
  };
</script>

{#if isShown}
  <section class="px-4 pt-4 text-sm" data-testid="detail-panel-transcript">
    <div class="flex h-10 w-full items-center justify-between gap-2">
      <Text size="small" color="muted">{$t('transcript')}</Text>
      <label
        class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"
        title={$t('transcript_follow_playback_description')}
      >
        <input type="checkbox" bind:checked={follow} class="accent-immich-primary dark:accent-immich-dark-primary" />
        {$t('transcript_follow_playback')}
      </label>
    </div>

    <div
      class="mb-2 flex items-center gap-2 rounded-lg border border-gray-300 px-2 focus-within:border-immich-primary dark:border-gray-600 dark:focus-within:border-immich-dark-primary"
    >
      <Icon icon={mdiMagnify} size="16" class="shrink-0 text-gray-500" />
      <input
        bind:value={query}
        type="search"
        class="w-full bg-transparent py-1.5 text-sm outline-none"
        placeholder={$t('transcript_search')}
        aria-label={$t('transcript_search')}
        onkeydown={onSearchKeydown}
      />
    </div>

    {#if lines.length === 0}
      <Text size="small" color="muted" class="pb-2">{$t('transcript_no_matches')}</Text>
    {:else}
      <ol
        bind:this={list}
        class="relative flex max-h-80 flex-col gap-0.5 overflow-y-auto overscroll-contain pe-1"
        lang={videoTranscriptManager.language ?? undefined}
      >
        {#each lines as { segment, index } (index)}
          {@const time = formatVideoPosition(segment.startTime)}
          {@const isActive = index === activeIndex}
          <li data-index={index}>
            <button
              type="button"
              class="flex w-full items-start gap-2 rounded-lg p-1 text-start transition-colors hover:bg-subtle dark:hover:bg-immich-dark-gray {isActive
                ? 'bg-immich-primary/10 dark:bg-immich-dark-primary/15'
                : ''}"
              title={$t('jump_to_time', { values: { time } })}
              aria-current={isActive ? 'true' : undefined}
              onclick={() => playFrom(segment.startTime)}
            >
              <span
                class="mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums {isActive
                  ? 'bg-immich-primary text-white dark:bg-immich-dark-primary dark:text-black'
                  : 'bg-immich-primary/15 text-immich-primary dark:bg-immich-dark-primary/15 dark:text-immich-dark-primary'}"
              >
                {time}
              </span>
              <span class="min-w-0 flex-1">{segment.text}</span>
            </button>
          </li>
        {/each}
      </ol>
    {/if}
  </section>
{/if}
