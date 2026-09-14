import { AssetTypeEnum, type AssetFaceResponseDto } from '@immich/sdk';
import type { Faces } from '$lib/managers/asset-viewer-manager.svelte';
import { getAssetMediaUrl, getAssetPlaybackUrl } from '$lib/utils';
import { mapNormalizedRectToContent, type Rect, type Size } from '$lib/utils/container-utils';

export type BoundingBox = Rect & { id: string };

export const VIDEO_FRAME_TIMEOUT_MS = 5000;

export const getBoundingBox = (faces: Faces[], imageSize: Size): BoundingBox[] => {
  const boxes: BoundingBox[] = [];

  for (const face of faces) {
    const rect = mapNormalizedRectToContent(
      { x: face.boundingBoxX1 / face.imageWidth, y: face.boundingBoxY1 / face.imageHeight },
      { x: face.boundingBoxX2 / face.imageWidth, y: face.boundingBoxY2 / face.imageHeight },
      imageSize,
    );

    boxes.push({ id: face.id, ...rect });
  }

  return boxes;
};

const releaseVideo = (video: HTMLVideoElement) => {
  try {
    video.removeAttribute('src');
    video.load();
  } catch {
    // ignore, the element is discarded anyway
  }
};

/**
 * Loads a video in an offscreen element and seeks to the given timestamp.
 * Resolves with the element once the frame is ready, or null on error or timeout.
 */
export const loadVideoFrame = (
  src: string,
  timestampMs: number,
  timeoutMs = VIDEO_FRAME_TIMEOUT_MS,
): Promise<HTMLVideoElement | null> => {
  const video = document.createElement('video');
  video.muted = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';

  return new Promise((resolve) => {
    let settled = false;

    const finish = (result: HTMLVideoElement | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (!result) {
        releaseVideo(video);
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    video.addEventListener(
      'loadedmetadata',
      () => {
        const target = Math.max(0, timestampMs / 1000);
        const duration = video.duration;
        video.currentTime = Number.isFinite(duration) && duration > 0 ? Math.min(target, duration) : target;
      },
      { once: true },
    );
    video.addEventListener('seeked', () => finish(video.videoWidth > 0 && video.videoHeight > 0 ? video : null), {
      once: true,
    });
    video.addEventListener('error', () => finish(null), { once: true });

    video.src = src;
  });
};

const cropFace = (
  face: AssetFaceResponseDto,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): string | null => {
  const { boundingBoxX1: x1, boundingBoxX2: x2, boundingBoxY1: y1, boundingBoxY2: y2, imageWidth, imageHeight } = face;

  const coordinates = {
    x1: (sourceWidth / imageWidth) * x1,
    x2: (sourceWidth / imageWidth) * x2,
    y1: (sourceHeight / imageHeight) * y1,
    y2: (sourceHeight / imageHeight) * y2,
  };

  const faceWidth = coordinates.x2 - coordinates.x1;
  const faceHeight = coordinates.y2 - coordinates.y1;

  const canvas = document.createElement('canvas');
  canvas.width = faceWidth;
  canvas.height = faceHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }
  context.drawImage(source, coordinates.x1, coordinates.y1, faceWidth, faceHeight, 0, 0, faceWidth, faceHeight);
  return canvas.toDataURL();
};

// grab one video frame at a time, so a panel with many faces does not open a stream per face
let videoFrameQueue: Promise<unknown> = Promise.resolve();

const cropFaceFromVideo = (face: AssetFaceResponseDto, assetId: string, frameTimestamp: number) => {
  const task = videoFrameQueue.then(async () => {
    const video = await loadVideoFrame(getAssetPlaybackUrl({ id: assetId }), frameTimestamp);
    if (!video) {
      return null;
    }

    try {
      return cropFace(face, video, video.videoWidth, video.videoHeight);
    } catch {
      return null;
    } finally {
      releaseVideo(video);
    }
  });

  videoFrameQueue = task.catch(() => null);
  return task;
};

export const zoomImageToBase64 = async (
  face: AssetFaceResponseDto,
  assetId: string,
  assetType: AssetTypeEnum,
  photoViewer: HTMLImageElement | undefined,
): Promise<string | null> => {
  // faces detected in a sampled video frame are not visible in the thumbnail
  if (assetType === AssetTypeEnum.Video && typeof face.frameTimestamp === 'number') {
    const result = await cropFaceFromVideo(face, assetId, face.frameTimestamp);
    if (result) {
      return result;
    }
  }

  let image: HTMLImageElement | undefined;
  if (assetType === AssetTypeEnum.Image) {
    image = photoViewer;
  } else if (assetType === AssetTypeEnum.Video) {
    const data = getAssetMediaUrl({ id: assetId });
    const img: HTMLImageElement = new Image();
    img.src = data;

    await new Promise<void>((resolve) => {
      img.addEventListener('load', () => resolve());
      img.addEventListener('error', () => resolve());
    });

    image = img;
  }
  if (!image) {
    return null;
  }

  const faceImage = new Image();
  faceImage.src = image.src;

  await new Promise((resolve) => {
    faceImage.addEventListener('load', resolve);
    faceImage.addEventListener('error', () => resolve(null));
  });

  return cropFace(face, faceImage, image.naturalWidth, image.naturalHeight);
};
