import sharp from 'sharp';
import { ImageSample, ImageSampleResult, Rotation } from 'src/takeout/types';

const SAMPLE_SIZE = 32;
const PIXEL_LIMIT = 268_402_689;
const MIN_SIMILARITY = 0.95;
const ASPECT_TOLERANCE = 0.02;

async function toBuffer(input: NodeJS.ReadableStream | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

// 32x32 auto-oriented greyscale sample plus the auto-oriented dimensions (spec 2.4).
export async function computeImageSample(input: NodeJS.ReadableStream | Buffer): Promise<ImageSampleResult> {
  const buffer = await toBuffer(input);
  let width: number;
  let height: number;
  try {
    const meta = await sharp(buffer, { failOn: 'none', limitInputPixels: PIXEL_LIMIT }).metadata();
    const orientation = meta.orientation ?? 1;
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w > 0 && h > 0 && w * h > PIXEL_LIMIT) {
      return { skipped: 'tooLarge' };
    }
    [width, height] = orientation >= 5 ? [h, w] : [w, h];
  } catch {
    return { skipped: 'decodeError' };
  }
  try {
    const sample = await sharp(buffer, { failOn: 'none', limitInputPixels: PIXEL_LIMIT })
      .rotate()
      .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'fill', kernel: 'cubic' })
      .greyscale()
      .raw()
      .toBuffer();
    if (sample.length !== SAMPLE_SIZE * SAMPLE_SIZE) {
      return { skipped: 'decodeError' };
    }
    return { width, height, sample };
  } catch {
    return { skipped: 'decodeError' };
  }
}

// Rotates the 32x32 grey grid clockwise by the given angle (equivalent to Go's resize-after-rotate for a square box).
export function rotateSample(sample: Buffer, angle: Rotation): Buffer {
  if (angle === 0) {
    return sample;
  }
  const n = SAMPLE_SIZE;
  const out = Buffer.allocUnsafe(n * n);
  for (let r = 0; r < n; r++) {
    for (let col = 0; col < n; col++) {
      let sr: number;
      let sc: number;
      if (angle === 90) {
        sr = n - 1 - col;
        sc = r;
      } else if (angle === 180) {
        sr = n - 1 - r;
        sc = n - 1 - col;
      } else {
        sr = col;
        sc = n - 1 - r;
      }
      out[r * n + col] = sample[sr * n + sc];
    }
  }
  return out;
}

function sampleVector(sample: Buffer): Float64Array {
  const v = new Float64Array(sample.length);
  let mean = 0;
  for (let i = 0; i < sample.length; i++) {
    v[i] = sample[i];
    mean += sample[i];
  }
  mean /= sample.length;
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    v[i] -= mean;
    norm += v[i] * v[i];
  }
  if (norm === 0) {
    return v;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < v.length; i++) {
    v[i] /= norm;
  }
  return v;
}

function similarity(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * b[i];
  }
  return s;
}

// Port of Go detectRotation over the 32x32 grey samples. Returns the clockwise angle turning original into edited.
export function detectRotationFromSamples(original: ImageSample, edited: ImageSample): Rotation {
  if (edited.width === 0 || edited.height === 0) {
    return 0;
  }
  const editedAspect = edited.width / edited.height;
  const editedVector = sampleVector(edited.sample);

  const candidates: Array<{ angle: Rotation; aspect: number; sample: Buffer }> = [
    { angle: 0, aspect: original.width / original.height, sample: original.sample },
    { angle: 90, aspect: original.height / original.width, sample: rotateSample(original.sample, 90) },
    { angle: 180, aspect: original.width / original.height, sample: rotateSample(original.sample, 180) },
    { angle: 270, aspect: original.height / original.width, sample: rotateSample(original.sample, 270) },
  ];

  let bestAngle: Rotation = 0;
  let bestSimilarity = -1;
  for (const candidate of candidates) {
    if (Math.abs(candidate.aspect - editedAspect) / editedAspect > ASPECT_TOLERANCE) {
      continue;
    }
    const s = similarity(sampleVector(candidate.sample), editedVector);
    if (s > bestSimilarity) {
      bestAngle = candidate.angle;
      bestSimilarity = s;
    }
  }
  return bestSimilarity < MIN_SIMILARITY ? 0 : bestAngle;
}
