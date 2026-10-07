import type { SearchMatchedFrameResponseDto } from '@immich/sdk';
import { SvelteMap } from 'svelte/reactivity';

/** Where smart search matched inside the videos of the shown results, so the player can jump to that moment */
class VideoSearchMatchManager {
  #frames = new SvelteMap<string, number>();

  add(matches: SearchMatchedFrameResponseDto[] = []) {
    for (const { assetId, frameTimestamp } of matches) {
      this.#frames.set(assetId, frameTimestamp);
    }
  }

  /** Position in milliseconds of the frame that matched, if the video matched on a frame rather than its thumbnail */
  get(assetId: string) {
    return this.#frames.get(assetId);
  }

  clear() {
    this.#frames.clear();
  }
}

export const videoSearchMatchManager = new VideoSearchMatchManager();
