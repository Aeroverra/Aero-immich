import { getAssetTranscript, type AssetTranscriptSegmentResponseDto } from '@immich/sdk';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';
import { toWebVtt } from '$lib/utils/video-transcript';

/** Transcript of the video open in the viewer, shared by the player (captions, position) and the info panel */
class VideoTranscriptManager {
  assetId = $state<string>();
  language = $state<string | null>(null);
  segments = $state<AssetTranscriptSegmentResponseDto[]>([]);
  /** WebVTT captions made from the segments, as an object URL for a track element */
  captionsUrl = $state<string>();
  /** playback position of the player showing the video, in milliseconds */
  position = $state(0);
  playing = $state(false);

  async load(assetId: string) {
    if (this.assetId === assetId) {
      return;
    }

    this.clear();
    this.assetId = assetId;
    try {
      const transcript = await getAssetTranscript({ id: assetId });
      if (this.assetId !== assetId) {
        return;
      }
      this.language = transcript.language;
      this.segments = transcript.segments;
      if (transcript.segments.length > 0) {
        this.captionsUrl = URL.createObjectURL(new Blob([toWebVtt(transcript.segments)], { type: 'text/vtt' }));
      }
    } catch (error) {
      const translate = await getFormatter();
      handleError(error, translate('errors.unable_to_load_transcript'), { notify: false });
    }
  }

  setPlayback(assetId: string, position: number, playing: boolean) {
    if (this.assetId !== assetId) {
      return;
    }
    this.position = position;
    this.playing = playing;
  }

  clear() {
    if (this.captionsUrl) {
      URL.revokeObjectURL(this.captionsUrl);
    }
    this.assetId = undefined;
    this.language = null;
    this.segments = [];
    this.captionsUrl = undefined;
    this.position = 0;
    this.playing = false;
  }
}

export const videoTranscriptManager = new VideoTranscriptManager();
