import {
  cosineDistance,
  getVideoFrameTimestamps,
  groupVideoFrameFaces,
  removeDuplicateFrames,
  VideoFrameFace,
} from 'src/utils/video-frame';
import { describe, expect, it } from 'vitest';

const defaults = { frameDensity: 1.2, minFrameInterval: 2, maxFrames: 30 };

const face = (embedding: number[], overrides: Partial<VideoFrameFace> = {}): VideoFrameFace => ({
  frameTimestamp: 0,
  imageWidth: 1920,
  imageHeight: 1080,
  boundingBox: { x1: 100, y1: 100, x2: 300, y2: 300 },
  score: 0.9,
  embedding: JSON.stringify(embedding),
  ...overrides,
});

describe('getVideoFrameTimestamps', () => {
  it.each([
    { seconds: 1.5, count: 1 },
    { seconds: 3, count: 1 },
    { seconds: 10, count: 4 },
    { seconds: 30, count: 7 },
    { seconds: 60, count: 9 },
    { seconds: 180, count: 16 },
    { seconds: 300, count: 21 },
    { seconds: 600, count: 29 },
    { seconds: 1200, count: 30 },
    { seconds: 3600, count: 30 },
  ])('should sample $count frames from a $seconds second video', ({ seconds, count }) => {
    expect(getVideoFrameTimestamps(seconds * 1000, defaults)).toHaveLength(count);
  });

  it('should take each frame from the middle of its slice', () => {
    expect(getVideoFrameTimestamps(10_000, defaults)).toEqual([1250, 3750, 6250, 8750]);
  });

  it('should keep frames at least the minimum interval apart', () => {
    const timestamps = getVideoFrameTimestamps(20_000, { frameDensity: 10, minFrameInterval: 5, maxFrames: 100 });
    expect(timestamps).toEqual([2500, 7500, 12_500, 17_500]);
  });

  it('should respect the maximum', () => {
    expect(getVideoFrameTimestamps(3_600_000, { ...defaults, maxFrames: 5 })).toHaveLength(5);
  });

  it.each([null, undefined, 0, -1, NaN])('should return nothing for a duration of %s', (duration) => {
    expect(getVideoFrameTimestamps(duration, defaults)).toEqual([]);
  });
});

describe('cosineDistance', () => {
  it('should be 0 for the same direction and 1 for orthogonal vectors', () => {
    expect(cosineDistance([1, 2], [2, 4])).toBeCloseTo(0);
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1);
  });

  it('should treat a zero vector as unrelated', () => {
    expect(cosineDistance([0, 0], [1, 1])).toBe(1);
  });
});

describe('removeDuplicateFrames', () => {
  it('should drop frames that look like the previous kept frame', () => {
    const frames = [
      { frameTimestamp: 1, embedding: '[1, 0]' },
      { frameTimestamp: 2, embedding: '[1, 0.01]' },
      { frameTimestamp: 3, embedding: '[0, 1]' },
      { frameTimestamp: 4, embedding: '[1, 0]' },
    ];

    expect(removeDuplicateFrames(frames, 0.03).map(({ frameTimestamp }) => frameTimestamp)).toEqual([1, 3, 4]);
  });

  it('should drop frames that look like the thumbnail', () => {
    const frames = [
      { frameTimestamp: 1, embedding: '[1, 0]' },
      { frameTimestamp: 2, embedding: '[0, 1]' },
    ];

    expect(removeDuplicateFrames(frames, 0.03, '[1, 0.001]').map(({ frameTimestamp }) => frameTimestamp)).toEqual([2]);
  });
});

describe('groupVideoFrameFaces', () => {
  it('should keep one face per person with the best detection', () => {
    const groups = groupVideoFrameFaces(
      [
        face([1, 0], { frameTimestamp: 1, score: 0.8 }),
        face([0.99, 0.05], { frameTimestamp: 2, score: 0.95 }),
        face([1, 0.02], { frameTimestamp: 2, score: 0.7 }),
        face([0, 1], { frameTimestamp: 3 }),
      ],
      0.4,
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ face: expect.objectContaining({ score: 0.95 }), frameCount: 2 });
    expect(groups[1]).toEqual({ face: expect.objectContaining({ frameTimestamp: 3 }), frameCount: 1 });
  });

  it('should prefer larger faces with the same score', () => {
    const [group] = groupVideoFrameFaces(
      [
        face([1, 0], { frameTimestamp: 1, boundingBox: { x1: 0, y1: 0, x2: 50, y2: 50 } }),
        face([1, 0], { frameTimestamp: 2, boundingBox: { x1: 0, y1: 0, x2: 400, y2: 400 } }),
      ],
      0.4,
    );

    expect(group.face.frameTimestamp).toBe(2);
  });
});
