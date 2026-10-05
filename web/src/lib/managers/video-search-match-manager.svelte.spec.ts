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

  it('should forget everything on clear', () => {
    videoSearchMatchManager.add([{ assetId: 'video-1', frameTimestamp: 1000 }]);

    videoSearchMatchManager.clear();

    expect(videoSearchMatchManager.get('video-1')).toBeUndefined();
  });
});
