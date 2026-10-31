import { SystemConfig } from 'src/dtos/config.dto';
import { BoundingBox } from 'src/repositories/machine-learning.repository';

type FrameSamplingOptions = Pick<
  SystemConfig['machineLearning']['videoFrameAnalysis'],
  'frameDensity' | 'minFrameInterval' | 'maxFrames'
>;

/**
 * Picks the positions (in milliseconds) of the frames to analyze in a video.
 * The number of frames grows with the square root of the duration, frames are at least
 * `minFrameInterval` seconds apart and at most `maxFrames` are taken. Each frame is taken
 * from the middle of its slice of the video, which skips fade-ins and black first frames.
 */
export const getVideoFrameTimestamps = (
  durationMs: number | null | undefined,
  { frameDensity, minFrameInterval, maxFrames }: FrameSamplingOptions,
): number[] => {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) {
    return [];
  }

  const seconds = durationMs / 1000;
  const countBySpacing = Math.max(1, Math.floor(seconds / minFrameInterval));
  const countByDensity = Math.round(frameDensity * Math.sqrt(seconds));
  const count = Math.max(1, Math.min(countByDensity, countBySpacing, maxFrames));

  const step = durationMs / count;
  return Array.from({ length: count }, (_, index) => Math.floor(step * (index + 0.5)));
};

export const parseEmbedding = (embedding: string | number[]): number[] =>
  typeof embedding === 'string' ? (JSON.parse(embedding) as number[]) : embedding;

export const cosineDistance = (a: number[], b: number[]): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (normA === 0 || normB === 0) {
    return 1;
  }

  return 1 - dot / Math.sqrt(normA * normB);
};

export interface VideoFrameEmbedding {
  frameTimestamp: number;
  embedding: string;
}

/**
 * Drops frames that look almost the same as the previously kept frame or as the thumbnail,
 * since they cannot improve search results.
 */
export const removeDuplicateFrames = (
  frames: VideoFrameEmbedding[],
  maxDistance: number,
  thumbnailEmbedding?: string | null,
): VideoFrameEmbedding[] => {
  const thumbnail = thumbnailEmbedding ? parseEmbedding(thumbnailEmbedding) : undefined;
  const kept: VideoFrameEmbedding[] = [];
  let previous: number[] | undefined;

  for (const frame of frames) {
    const embedding = parseEmbedding(frame.embedding);
    const isDuplicate =
      (previous && cosineDistance(previous, embedding) <= maxDistance) ||
      (thumbnail && cosineDistance(thumbnail, embedding) <= maxDistance);

    if (isDuplicate) {
      continue;
    }

    kept.push(frame);
    previous = embedding;
  }

  return kept;
};

export interface VideoFrameFace {
  frameTimestamp: number;
  imageWidth: number;
  imageHeight: number;
  boundingBox: BoundingBox;
  score: number;
  embedding: string;
}

export interface VideoFrameFaceGroup {
  /** the clearest, largest detection of this person in the video */
  face: VideoFrameFace;
  /** number of distinct frames this person was detected in */
  frameCount: number;
}

const getFaceQuality = ({ score, boundingBox }: VideoFrameFace) =>
  score * Math.sqrt(Math.max(0, boundingBox.x2 - boundingBox.x1) * Math.max(0, boundingBox.y2 - boundingBox.y1));

export const getFaceSize = ({ boundingBox }: Pick<VideoFrameFace, 'boundingBox'>) =>
  Math.min(boundingBox.x2 - boundingBox.x1, boundingBox.y2 - boundingBox.y1);

/**
 * Groups the faces detected across the frames of one video so that every person is kept once.
 * Faces are visited from best to worst quality and join the first group whose best face is
 * within `maxDistance`.
 */
export const groupVideoFrameFaces = (faces: VideoFrameFace[], maxDistance: number): VideoFrameFaceGroup[] => {
  const groups: { face: VideoFrameFace; embedding: number[]; frames: Set<number> }[] = [];

  for (const face of faces.toSorted((a, b) => getFaceQuality(b) - getFaceQuality(a))) {
    const embedding = parseEmbedding(face.embedding);
    const group = groups.find((group) => cosineDistance(group.embedding, embedding) <= maxDistance);
    if (group) {
      group.frames.add(face.frameTimestamp);
      continue;
    }

    groups.push({ face, embedding, frames: new Set([face.frameTimestamp]) });
  }

  return groups.map(({ face, frames }) => ({ face, frameCount: frames.size }));
};
