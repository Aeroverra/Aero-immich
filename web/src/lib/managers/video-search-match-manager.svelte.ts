import type { SearchMatchedFrameResponseDto, SearchMatchedTranscriptResponseDto } from '@immich/sdk';
import { SvelteMap } from 'svelte/reactivity';

/** `frame`: smart search matched a sampled frame, `speech`: a spoken words search matched a line of the transcript */
export type VideoSearchMatchKind = 'frame' | 'speech';

/** Where search matched inside the videos of the shown results, so the player can jump to that moment */
class VideoSearchMatchManager {
  #matches = new SvelteMap<string, { time: number; kind: VideoSearchMatchKind }>();

  add(matches: SearchMatchedFrameResponseDto[] = []) {
    for (const { assetId, frameTimestamp } of matches) {
      this.#matches.set(assetId, { time: frameTimestamp, kind: 'frame' });
    }
  }

  addSpeech(matches: SearchMatchedTranscriptResponseDto[] = []) {
    for (const { assetId, startTime } of matches) {
      this.#matches.set(assetId, { time: startTime, kind: 'speech' });
    }
  }

  /** Position in milliseconds of the moment that matched, if the video matched inside rather than on its thumbnail */
  get(assetId: string) {
    return this.#matches.get(assetId)?.time;
  }

  getKind(assetId: string): VideoSearchMatchKind | undefined {
    return this.#matches.get(assetId)?.kind;
  }

  clear() {
    this.#matches.clear();
  }
}

export const videoSearchMatchManager = new VideoSearchMatchManager();
