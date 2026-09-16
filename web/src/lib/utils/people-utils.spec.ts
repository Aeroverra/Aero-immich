import { AssetTypeEnum, SourceType, type AssetFaceResponseDto } from '@immich/sdk';
import type { Faces } from '$lib/managers/asset-viewer-manager.svelte';
import type { Size } from '$lib/utils/container-utils';
import { getBoundingBox, loadVideoFrame, VIDEO_FRAME_TIMEOUT_MS, zoomImageToBase64 } from '$lib/utils/people-utils';

const makeFace = (overrides: Partial<Faces> = {}): Faces => ({
  id: 'face-1',
  imageWidth: 4000,
  imageHeight: 3000,
  boundingBoxX1: 1000,
  boundingBoxY1: 750,
  boundingBoxX2: 2000,
  boundingBoxY2: 1500,
  ...overrides,
});

describe('getBoundingBox', () => {
  it('should scale face coordinates to display dimensions', () => {
    const face = makeFace();
    const imageSize: Size = { width: 800, height: 600 };

    const boxes = getBoundingBox([face], imageSize);

    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toEqual({
      id: 'face-1',
      top: 600 * (750 / 3000),
      left: 800 * (1000 / 4000),
      width: 800 * (2000 / 4000) - 800 * (1000 / 4000),
      height: 600 * (1500 / 3000) - 600 * (750 / 3000),
    });
  });

  it('should map full-image face to full display area', () => {
    const face = makeFace({
      imageWidth: 1000,
      imageHeight: 1000,
      boundingBoxX1: 0,
      boundingBoxY1: 0,
      boundingBoxX2: 1000,
      boundingBoxY2: 1000,
    });
    const imageSize: Size = { width: 600, height: 600 };

    const boxes = getBoundingBox([face], imageSize);

    expect(boxes[0]).toEqual({
      id: 'face-1',
      top: 0,
      left: 0,
      width: 600,
      height: 600,
    });
  });

  it('should return empty array for empty faces', () => {
    expect(getBoundingBox([], { width: 800, height: 600 })).toEqual([]);
  });

  it('should handle multiple faces', () => {
    const faces = [
      makeFace({ id: 'face-1', boundingBoxX1: 0, boundingBoxY1: 0, boundingBoxX2: 1000, boundingBoxY2: 1000 }),
      makeFace({ id: 'face-2', boundingBoxX1: 2000, boundingBoxY1: 1500, boundingBoxX2: 3000, boundingBoxY2: 2500 }),
    ];

    const boxes = getBoundingBox(faces, { width: 800, height: 600 });

    expect(boxes).toHaveLength(2);
    expect(boxes[0].left).toBeLessThan(boxes[1].left);
  });
});

const makeAssetFace = (overrides: Partial<AssetFaceResponseDto> = {}): AssetFaceResponseDto => ({
  id: 'face-1',
  imageWidth: 1000,
  imageHeight: 500,
  boundingBoxX1: 100,
  boundingBoxY1: 50,
  boundingBoxX2: 300,
  boundingBoxY2: 250,
  person: null,
  sourceType: SourceType.MachineLearning,
  ...overrides,
});

class FakeImage extends EventTarget {
  naturalWidth = 500;
  naturalHeight = 250;
  #src = '';

  get src() {
    return this.#src;
  }

  set src(value: string) {
    this.#src = value;
    queueMicrotask(() => this.dispatchEvent(new Event('load')));
  }
}

const setVideoSize = (video: HTMLVideoElement, width: number, height: number) => {
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: width },
    videoHeight: { configurable: true, value: height },
  });
};

describe('video frame face crops', () => {
  let videos: HTMLVideoElement[];
  let drawImage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    videos = [];
    drawImage = vi.fn();

    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) => {
      const element = createElement(tagName, options);
      if (tagName === 'video') {
        videos.push(element as HTMLVideoElement);
      }
      return element;
    });
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,crop');
    vi.stubGlobal('Image', FakeImage);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const waitForVideo = async () => {
    await vi.waitFor(() => expect(videos).toHaveLength(1));
    return videos[0];
  };

  describe('loadVideoFrame', () => {
    it('should seek to the frame timestamp and resolve with the video', async () => {
      const promise = loadVideoFrame('/api/assets/asset-1/video/playback', 12_500);
      const video = videos[0];
      expect(video.src).toContain('/api/assets/asset-1/video/playback');

      Object.defineProperty(video, 'duration', { configurable: true, value: 60 });
      video.dispatchEvent(new Event('loadedmetadata'));
      expect(video.currentTime).toBe(12.5);

      setVideoSize(video, 1920, 1080);
      video.dispatchEvent(new Event('seeked'));

      await expect(promise).resolves.toBe(video);
    });

    it('should clamp the seek position to the video duration', () => {
      void loadVideoFrame('/playback', 90_000);
      const video = videos[0];

      Object.defineProperty(video, 'duration', { configurable: true, value: 30 });
      video.dispatchEvent(new Event('loadedmetadata'));

      expect(video.currentTime).toBe(30);
    });

    it('should resolve with null when the video fails to load', async () => {
      const promise = loadVideoFrame('/playback', 1000);
      videos[0].dispatchEvent(new Event('error'));

      await expect(promise).resolves.toBeNull();
    });

    it('should resolve with null after the timeout', async () => {
      vi.useFakeTimers();
      const promise = loadVideoFrame('/playback', 1000);

      vi.advanceTimersByTime(VIDEO_FRAME_TIMEOUT_MS);

      await expect(promise).resolves.toBeNull();
    });
  });

  describe('zoomImageToBase64', () => {
    it('should crop a video frame face from the video frame', async () => {
      const promise = zoomImageToBase64(
        makeAssetFace({ frameTimestamp: 4000 }),
        'asset-1',
        AssetTypeEnum.Video,
        undefined,
      );

      const video = await waitForVideo();
      expect(video.src).toContain('/assets/asset-1/video/playback');
      video.dispatchEvent(new Event('loadedmetadata'));
      setVideoSize(video, 2000, 1000);
      video.dispatchEvent(new Event('seeked'));

      await expect(promise).resolves.toBe('data:image/png;base64,crop');
      expect(drawImage).toHaveBeenCalledWith(video, 200, 100, 400, 400, 0, 0, 400, 400);
    });

    it('should fall back to the thumbnail when the video frame cannot be loaded', async () => {
      const promise = zoomImageToBase64(
        makeAssetFace({ frameTimestamp: 4000 }),
        'asset-1',
        AssetTypeEnum.Video,
        undefined,
      );

      const video = await waitForVideo();
      video.dispatchEvent(new Event('error'));

      await expect(promise).resolves.toBe('data:image/png;base64,crop');
      expect(drawImage).toHaveBeenCalledTimes(1);
      expect(drawImage.mock.calls[0][0]).toBeInstanceOf(FakeImage);
      expect(drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 50, 25, 100, 100, 0, 0, 100, 100);
    });

    it('should use the thumbnail for video faces without a frame timestamp', async () => {
      await expect(
        zoomImageToBase64(makeAssetFace({ frameTimestamp: null }), 'asset-1', AssetTypeEnum.Video, undefined),
      ).resolves.toBe('data:image/png;base64,crop');

      expect(videos).toHaveLength(0);
      expect(drawImage.mock.calls[0][0]).toBeInstanceOf(FakeImage);
    });

    it('should never load a video for images', async () => {
      const photoViewer = new FakeImage() as unknown as HTMLImageElement;
      photoViewer.src = '/photo.jpg';

      await expect(
        zoomImageToBase64(makeAssetFace({ frameTimestamp: 4000 }), 'asset-1', AssetTypeEnum.Image, photoViewer),
      ).resolves.toBe('data:image/png;base64,crop');

      expect(videos).toHaveLength(0);
    });
  });
});
