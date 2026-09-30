import type { VideoBookmarkResponseDto } from '@immich/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { videoBookmarkManager } from '$lib/managers/video-bookmark-manager.svelte';

const newBookmark = (overrides: Partial<VideoBookmarkResponseDto> = {}): VideoBookmarkResponseDto => ({
  id: 'bookmark-1',
  assetId: 'asset-1',
  time: 1000,
  label: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('VideoBookmarkManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    videoBookmarkManager.clear();
  });

  it('loads the bookmarks of a video in time order, once per video', async () => {
    sdkMock.getVideoBookmarks.mockResolvedValue([
      newBookmark({ id: 'late', time: 90_000 }),
      newBookmark({ id: 'early', time: 5000 }),
    ]);

    await videoBookmarkManager.load('asset-1');
    await videoBookmarkManager.load('asset-1');

    expect(sdkMock.getVideoBookmarks).toHaveBeenCalledTimes(1);
    expect(sdkMock.getVideoBookmarks).toHaveBeenCalledWith({ assetId: 'asset-1' });
    expect(videoBookmarkManager.bookmarks.map(({ id }) => id)).toEqual(['early', 'late']);
  });

  it('ignores a slow response for a video that is no longer open', async () => {
    let resolveFirst: (value: VideoBookmarkResponseDto[]) => void = () => {};
    sdkMock.getVideoBookmarks
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce([newBookmark({ id: 'second', assetId: 'asset-2' })]);

    const first = videoBookmarkManager.load('asset-1');
    await videoBookmarkManager.load('asset-2');
    resolveFirst([newBookmark({ id: 'first' })]);
    await first;

    expect(videoBookmarkManager.assetId).toBe('asset-2');
    expect(videoBookmarkManager.bookmarks.map(({ id }) => id)).toEqual(['second']);
  });

  it('adds a bookmark at the position of the attached player, rounded to whole milliseconds', async () => {
    sdkMock.getVideoBookmarks.mockResolvedValue([newBookmark({ id: 'later', time: 60_000 })]);
    sdkMock.createVideoBookmark.mockResolvedValue(newBookmark({ id: 'new', time: 12_346 }));
    await videoBookmarkManager.load('asset-1');
    const detach = videoBookmarkManager.attachPlayer('asset-1', () => 12_345.6);

    await expect(videoBookmarkManager.addAtCurrentPosition('asset-1')).resolves.toEqual(
      expect.objectContaining({ id: 'new' }),
    );

    expect(sdkMock.createVideoBookmark).toHaveBeenCalledWith({
      videoBookmarkCreateDto: { assetId: 'asset-1', time: 12_346 },
    });
    expect(videoBookmarkManager.bookmarks.map(({ id }) => id)).toEqual(['new', 'later']);

    detach();
    await expect(videoBookmarkManager.addAtCurrentPosition('asset-1')).resolves.toBeUndefined();
    expect(sdkMock.createVideoBookmark).toHaveBeenCalledTimes(1);
  });

  it('does not add a bookmark for another video than the attached player shows', async () => {
    videoBookmarkManager.attachPlayer('asset-1', () => 1000);

    await expect(videoBookmarkManager.addAtCurrentPosition('asset-2')).resolves.toBeUndefined();

    expect(sdkMock.createVideoBookmark).not.toHaveBeenCalled();
  });

  it('renames and removes bookmarks', async () => {
    sdkMock.getVideoBookmarks.mockResolvedValue([newBookmark({ id: 'a' }), newBookmark({ id: 'b', time: 2000 })]);
    sdkMock.updateVideoBookmark.mockResolvedValue(newBookmark({ id: 'a', label: 'Cake' }));
    sdkMock.deleteVideoBookmark.mockResolvedValue(undefined as never);
    await videoBookmarkManager.load('asset-1');

    await videoBookmarkManager.rename('a', 'Cake');
    await videoBookmarkManager.rename('a', ' Cake ');
    await videoBookmarkManager.remove('b');

    expect(sdkMock.updateVideoBookmark).toHaveBeenCalledTimes(1);
    expect(sdkMock.updateVideoBookmark).toHaveBeenCalledWith({ id: 'a', videoBookmarkUpdateDto: { label: 'Cake' } });
    expect(sdkMock.deleteVideoBookmark).toHaveBeenCalledWith({ id: 'b' });
    expect(videoBookmarkManager.bookmarks).toEqual([expect.objectContaining({ id: 'a', label: 'Cake' })]);
  });

  it('moves a bookmark right away and saves quick moves once', async () => {
    vi.useFakeTimers();
    try {
      sdkMock.getVideoBookmarks.mockResolvedValue([
        newBookmark({ id: 'a', time: 10_000 }),
        newBookmark({ id: 'b', time: 20_000 }),
      ]);
      sdkMock.updateVideoBookmark.mockResolvedValue(newBookmark({ id: 'a', time: 23_000 }));
      await videoBookmarkManager.load('asset-1');

      videoBookmarkManager.setTime('a', 11_000);
      videoBookmarkManager.setTime('a', 23_000);

      // re-sorted immediately, nothing sent yet
      expect(videoBookmarkManager.bookmarks.map(({ id, time }) => `${id}@${time}`)).toEqual(['b@20000', 'a@23000']);
      expect(sdkMock.updateVideoBookmark).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      expect(sdkMock.updateVideoBookmark).toHaveBeenCalledTimes(1);
      expect(sdkMock.updateVideoBookmark).toHaveBeenCalledWith({ id: 'a', videoBookmarkUpdateDto: { time: 23_000 } });

      // never before the start
      videoBookmarkManager.setTime('b', -5000);
      expect(videoBookmarkManager.bookmarks[0]).toEqual(expect.objectContaining({ id: 'b', time: 0 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds the next and the previous bookmark from a position', async () => {
    sdkMock.getVideoBookmarks.mockResolvedValue([
      newBookmark({ id: 'a', time: 10_000 }),
      newBookmark({ id: 'b', time: 20_000 }),
      newBookmark({ id: 'c', time: 30_000 }),
    ]);
    await videoBookmarkManager.load('asset-1');

    expect(videoBookmarkManager.next(0)?.id).toBe('a');
    // right on a bookmark (after a jump), next moves on instead of staying
    expect(videoBookmarkManager.next(10_000)?.id).toBe('b');
    expect(videoBookmarkManager.next(30_000)).toBeUndefined();
    // just after a bookmark, previous skips it so a second press keeps going back
    expect(videoBookmarkManager.previous(20_300)?.id).toBe('a');
    expect(videoBookmarkManager.previous(25_000)?.id).toBe('b');
    expect(videoBookmarkManager.previous(10_000)).toBeUndefined();
  });
});
