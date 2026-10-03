import { formatVideoResolution, getVideoPlaybackSource } from '$lib/utils/video-playback-source';

describe('getVideoPlaybackSource', () => {
  it('should be the transcoded copy when there is one', () => {
    expect(
      getVideoPlaybackSource({ realtimeTranscoding: false, playOriginalVideo: false, hasEncodedVideo: true }),
    ).toBe('transcoded');
  });

  it('should be the original when there is no transcoded copy', () => {
    expect(
      getVideoPlaybackSource({ realtimeTranscoding: false, playOriginalVideo: false, hasEncodedVideo: false }),
    ).toBe('original');
  });

  it('should be the original when the original is requested', () => {
    expect(getVideoPlaybackSource({ realtimeTranscoding: false, playOriginalVideo: true, hasEncodedVideo: true })).toBe(
      'original',
    );
  });

  it('should be the rotated transcoded copy when the original of a rotated video is requested', () => {
    const options = { realtimeTranscoding: false, playOriginalVideo: true, isEdited: true };
    expect(getVideoPlaybackSource({ ...options, hasEncodedVideo: true })).toBe('transcoded');
    expect(getVideoPlaybackSource({ ...options, hasEncodedVideo: false })).toBe('original');
  });

  it('should be a live transcode when realtime transcoding is on', () => {
    expect(getVideoPlaybackSource({ realtimeTranscoding: true, playOriginalVideo: true, hasEncodedVideo: false })).toBe(
      'live',
    );
  });

  it('should be unknown when the server does not say', () => {
    expect(getVideoPlaybackSource({ realtimeTranscoding: false, playOriginalVideo: false })).toBeUndefined();
  });
});

describe('formatVideoResolution', () => {
  it('should name landscape and portrait videos by the short side', () => {
    expect(formatVideoResolution(1280, 720)).toBe('720p');
    expect(formatVideoResolution(2160, 3840)).toBe('2160p');
  });

  it('should be empty before the video size is known', () => {
    expect(formatVideoResolution(0, 0)).toBeUndefined();
  });
});
