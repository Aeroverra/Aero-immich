import { videoSearchMatchManager } from '$lib/managers/video-search-match-manager.svelte';

describe('VideoSearchMatchManager', () => {
  afterEach(() => videoSearchMatchManager.clear());

  it('should remember where each video matched', () => {
    videoSearchMatchManager.add([
      { assetId: 'video-1', frameTimestamp: 83_000 },
      { assetId: 'video-2', frameTimestamp: 0 },
    ]);

    expect(videoSearchMatchManager.get('video-1')).toBe(83_000);
    expect(videoSearchMatchManager.get('video-2')).toBe(0);
    expect(videoSearchMatchManager.get('photo')).toBeUndefined();
  });

  it('should keep the matches of earlier pages', () => {
    videoSearchMatchManager.add([{ assetId: 'video-1', frameTimestamp: 1000 }]);
    videoSearchMatchManager.add([{ assetId: 'video-2', frameTimestamp: 2000 }]);
    videoSearchMatchManager.add();

    expect(videoSearchMatchManager.get('video-1')).toBe(1000);
    expect(videoSearchMatchManager.get('video-2')).toBe(2000);
  });

  it('should remember where the speech matched, and say so', () => {
    videoSearchMatchManager.add([{ assetId: 'video-1', frameTimestamp: 1000 }]);
    videoSearchMatchManager.addSpeech([
      { assetId: 'video-2', startTime: 484_000, endTime: 488_500, text: 'the full moon party' },
    ]);
    videoSearchMatchManager.addSpeech();

    expect(videoSearchMatchManager.get('video-2')).toBe(484_000);
    expect(videoSearchMatchManager.getKind('video-2')).toBe('speech');
    expect(videoSearchMatchManager.getKind('video-1')).toBe('frame');
    expect(videoSearchMatchManager.getKind('photo')).toBeUndefined();
  });

  it('should forget everything on clear', () => {
    videoSearchMatchManager.add([{ assetId: 'video-1', frameTimestamp: 1000 }]);

    videoSearchMatchManager.clear();

    expect(videoSearchMatchManager.get('video-1')).toBeUndefined();
  });
});
