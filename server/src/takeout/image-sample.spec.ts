import sharp from 'sharp';
import { computeImageSample, detectRotationFromSamples } from 'src/takeout/image-sample';
import { ImageSample } from 'src/takeout/types';
import { beforeAll, describe, expect, it } from 'vitest';

const W = 400;
const H = 300;

// Port of editedrotation_test.go testImage: an asymmetric pattern so every rotation looks different.
function testImageRaw(): Buffer {
  const buf = Buffer.allocUnsafe(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 3;
      let v = Math.floor((x * 255) / W);
      if (y < Math.floor(H / 3) && x < Math.floor(W / 2)) {
        v = 255 - Math.floor(v / 4);
      }
      buf[idx] = v;
      buf[idx + 1] = Math.floor((y * 255) / H);
      buf[idx + 2] = 128;
    }
  }
  return buf;
}

const raw = testImageRaw();
const from = () => sharp(raw, { raw: { width: W, height: H, channels: 3 } });

async function sample(png: Buffer): Promise<ImageSample> {
  const result = await computeImageSample(png);
  if ('skipped' in result) {
    throw new Error(`sample skipped: ${result.skipped}`);
  }
  return result;
}

describe('detectRotationFromSamples (TestDetectRotation)', () => {
  let original: ImageSample;
  const editedPng: Record<string, Buffer> = {};

  beforeAll(async () => {
    original = await sample(await from().png().toBuffer());
    editedPng.unchanged = await from().png().toBuffer();
    editedPng.cw90 = await from().rotate(90).png().toBuffer();
    editedPng.r180 = await from().rotate(180).png().toBuffer();
    editedPng.cw270 = await from().rotate(270).png().toBuffer();
    editedPng.resized = await from().rotate(90).resize(150, 200, { fit: 'fill' }).png().toBuffer();
    editedPng.cropped = await from().extract({ left: 0, top: 0, width: 250, height: 300 }).png().toBuffer();
    editedPng.inverted = await from().negate().png().toBuffer();
  });

  const cases: Array<{ name: string; key: string; want: 0 | 90 | 180 | 270 }> = [
    { name: 'unchanged', key: 'unchanged', want: 0 },
    { name: 'clockwise 90', key: 'cw90', want: 90 },
    { name: '180', key: 'r180', want: 180 },
    { name: 'clockwise 270', key: 'cw270', want: 270 },
    { name: 'rotated and resized', key: 'resized', want: 90 },
    { name: 'cropped', key: 'cropped', want: 0 },
    { name: 'color filter only', key: 'inverted', want: 0 },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const edited = await sample(editedPng[c.key]);
      expect(detectRotationFromSamples(original, edited)).toBe(c.want);
    });
  }
});
