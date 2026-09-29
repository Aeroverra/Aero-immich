export type VideoPlaybackSource = 'live' | 'original' | 'transcoded';

type VideoPlaybackSourceOptions = {
  realtimeTranscoding: boolean;
  playOriginalVideo: boolean;
  hasEncodedVideo?: boolean;
};

/** the file the player gets: /video/playback serves the transcoded copy when there is one, else the original */
export const getVideoPlaybackSource = ({
  realtimeTranscoding,
  playOriginalVideo,
  hasEncodedVideo,
}: VideoPlaybackSourceOptions): VideoPlaybackSource | undefined => {
  if (realtimeTranscoding) {
    return 'live';
  }

  if (playOriginalVideo) {
    return 'original';
  }

  // shared links without metadata do not say whether there is a transcoded copy
  if (hasEncodedVideo === undefined) {
    return undefined;
  }

  return hasEncodedVideo ? 'transcoded' : 'original';
};

/** the short side of the frame, the way video resolutions are named (720p, 1080p, 2160p) */
export const formatVideoResolution = (width: number, height: number) => {
  if (width <= 0 || height <= 0) {
    return;
  }

  return `${Math.min(width, height)}p`;
};
