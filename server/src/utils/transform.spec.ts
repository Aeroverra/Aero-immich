import { AssetEditAction, AssetEditActionItem, MirrorAxis } from 'src/dtos/editing.dto';
import { AssetOcrResponseDto } from 'src/dtos/ocr.dto';
import {
  getOutputDimensions,
  transformEditedFaceToOriginal,
  transformFaceBoundingBox,
  transformOcrBoundingBox,
} from 'src/utils/transform';
import { describe, expect, it } from 'vitest';

describe('transformFaceBoundingBox', () => {
  const baseFace = {
    boundingBoxX1: 100,
    boundingBoxY1: 100,
    boundingBoxX2: 200,
    boundingBoxY2: 200,
    imageWidth: 1000,
    imageHeight: 800,
  };

  const baseDimensions = { width: 1000, height: 800 };

  describe('with no edits', () => {
    it('should return unchanged bounding box', () => {
      const result = transformFaceBoundingBox(baseFace, [], baseDimensions);
      expect(result).toEqual(baseFace);
    });
  });

  describe('with crop edit', () => {
    it('should adjust bounding box for crop offset', () => {
      const edits: AssetEditActionItem[] = [
        { action: AssetEditAction.Crop, parameters: { x: 50, y: 50, width: 400, height: 300 } },
      ];
      const result = transformFaceBoundingBox(baseFace, edits, baseDimensions);

      expect(result.boundingBoxX1).toBe(50);
      expect(result.boundingBoxY1).toBe(50);
      expect(result.boundingBoxX2).toBe(150);
      expect(result.boundingBoxY2).toBe(150);
      expect(result.imageWidth).toBe(400);
      expect(result.imageHeight).toBe(300);
    });

    it('should handle face partially outside crop area', () => {
      const edits: AssetEditActionItem[] = [
        { action: AssetEditAction.Crop, parameters: { x: 150, y: 150, width: 400, height: 300 } },
      ];
      const result = transformFaceBoundingBox(baseFace, edits, baseDimensions);

      expect(result.boundingBoxX1).toBe(-50);
      expect(result.boundingBoxY1).toBe(-50);
      expect(result.boundingBoxX2).toBe(50);
      expect(result.boundingBoxY2).toBe(50);
    });
  });

  describe('with rotate edit', () => {
    it('should rotate 90 degrees clockwise', () => {
      const edits: AssetEditActionItem[] = [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }];
      const result = transformFaceBoundingBox(baseFace, edits, baseDimensions);

      expect(result.imageWidth).toBe(800);
      expect(result.imageHeight).toBe(1000);

      expect(result.boundingBoxX1).toBe(600);
      expect(result.boundingBoxY1).toBe(100);
      expect(result.boundingBoxX2).toBe(700);
      expect(result.boundingBoxY2).toBe(200);
    });

    it('should rotate 180 degrees', () => {
      const edits: AssetEditActionItem[] = [{ action: AssetEditAction.Rotate, parameters: { angle: 180 } }];
      const result = transformFaceBoundingBox(baseFace, edits, baseDimensions);

      expect(result.imageWidth).toBe(1000);
      expect(result.imageHeight).toBe(800);

      expect(result.boundingBoxX1).toBe(800);
      expect(result.boundingBoxY1).toBe(600);
      expect(result.boundingBoxX2).toBe(900);
      expect(result.boundingBoxY2).toBe(700);
    });

    it('should rotate 270 degrees', () => {
      const edits: AssetEditActionItem[] = [{ action: AssetEditAction.Rotate, parameters: { angle: 270 } }];
      const result = transformFaceBoundingBox(baseFace, edits, baseDimensions);

      expect(result.imageWidth).toBe(800);
      expect(result.imageHeight).toBe(1000);
    });
  });

  describe('with mirror edit', () => {
    it('should mirror horizontally', () => {
      const edits: AssetEditActionItem[] = [
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ];
      const result = transformFaceBoundingBox(baseFace, edits, baseDimensions);

      expect(result.boundingBoxX1).toBe(800);
      expect(result.boundingBoxY1).toBe(100);
      expect(result.boundingBoxX2).toBe(900);
      expect(result.boundingBoxY2).toBe(200);
      expect(result.imageWidth).toBe(1000);
      expect(result.imageHeight).toBe(800);
    });

    it('should mirror vertically', () => {
      const edits: AssetEditActionItem[] = [
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Vertical } },
      ];
      const result = transformFaceBoundingBox(baseFace, edits, baseDimensions);

      expect(result.boundingBoxX1).toBe(100);
      expect(result.boundingBoxY1).toBe(600);
      expect(result.boundingBoxX2).toBe(200);
      expect(result.boundingBoxY2).toBe(700);
      expect(result.imageWidth).toBe(1000);
      expect(result.imageHeight).toBe(800);
    });
  });

  describe('with combined edits', () => {
    it('should apply crop then rotate', () => {
      const edits: AssetEditActionItem[] = [
        { action: AssetEditAction.Crop, parameters: { x: 50, y: 50, width: 400, height: 300 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ];
      const result = transformFaceBoundingBox(baseFace, edits, baseDimensions);

      expect(result.imageWidth).toBe(300);
      expect(result.imageHeight).toBe(400);
    });

    it('should apply crop then mirror', () => {
      const edits: AssetEditActionItem[] = [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 500, height: 400 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Vertical } },
      ];
      const result = transformFaceBoundingBox(baseFace, edits, baseDimensions);

      expect(result.boundingBoxX1).toBe(100);
      expect(result.boundingBoxX2).toBe(200);
      expect(result.boundingBoxY1).toBe(200);
      expect(result.boundingBoxY2).toBe(300);
    });
  });

  describe('with scaled dimensions', () => {
    it('should scale face to match different image dimensions', () => {
      const scaledDimensions = { width: 500, height: 400 }; // Half the original size
      const edits: AssetEditActionItem[] = [
        { action: AssetEditAction.Crop, parameters: { x: 50, y: 50, width: 200, height: 150 } },
      ];
      const result = transformFaceBoundingBox(baseFace, edits, scaledDimensions);

      expect(result.boundingBoxX1).toBe(0);
      expect(result.boundingBoxY1).toBe(0);
      expect(result.boundingBoxX2).toBe(50);
      expect(result.boundingBoxY2).toBe(50);
    });

    it('should always return whole numbers', () => {
      const edits: AssetEditActionItem[] = [
        { action: AssetEditAction.Crop, parameters: { x: 50, y: 50, width: 250, height: 250 } },
      ];

      expect(transformFaceBoundingBox(baseFace, edits, { width: 1000, height: 400 })).toMatchObject({
        boundingBoxX1: 50,
        boundingBoxY1: 0,
        boundingBoxX2: 150,
        boundingBoxY2: 50,
      });

      expect(transformFaceBoundingBox(baseFace, edits, { width: 1001, height: 401 })).toMatchObject({
        boundingBoxX1: 50,
        boundingBoxY1: 0,
        boundingBoxX2: 150,
        boundingBoxY2: 50,
      });

      expect(transformFaceBoundingBox(baseFace, edits, { width: 999, height: 399 })).toMatchObject({
        boundingBoxX1: 49,
        boundingBoxY1: -0,
        boundingBoxX2: 149,
        boundingBoxY2: 49,
      });
    });
  });
});

describe('transformEditedFaceToOriginal', () => {
  const original = { width: 2580, height: 3220 };

  it('should map a face found on a rotated preview back to the unedited image', () => {
    const edits: AssetEditActionItem[] = [{ action: AssetEditAction.Rotate, parameters: { angle: 270 } }];

    const result = transformEditedFaceToOriginal({ x1: 1291, y1: 309, x2: 1416, y2: 485 }, edits, {
      source: { width: 1797, height: 1440 },
      edited: getOutputDimensions(edits, original),
      original,
    });

    expect(result).toEqual({
      boundingBoxX1: 1711,
      boundingBoxY1: 2313,
      boundingBoxX2: 2026,
      boundingBoxY2: 2537,
      imageWidth: 2580,
      imageHeight: 3220,
    });
  });

  it('should map a face found on a cropped preview back to the unedited image', () => {
    const edits: AssetEditActionItem[] = [
      { action: AssetEditAction.Crop, parameters: { x: 100, y: 200, width: 1000, height: 500 } },
    ];

    const result = transformEditedFaceToOriginal({ x1: 50, y1: 25, x2: 100, y2: 75 }, edits, {
      source: { width: 500, height: 250 },
      edited: getOutputDimensions(edits, original),
      original,
    });

    expect(result).toEqual({
      boundingBoxX1: 200,
      boundingBoxY1: 250,
      boundingBoxX2: 300,
      boundingBoxY2: 350,
      imageWidth: 2580,
      imageHeight: 3220,
    });
  });

  it('should use the inverse transform dimensions when the unedited dimensions are unknown', () => {
    const edits: AssetEditActionItem[] = [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }];

    const result = transformEditedFaceToOriginal({ x1: 10, y1: 20, x2: 30, y2: 40 }, edits, {
      source: { width: 400, height: 300 },
      edited: { width: 400, height: 300 },
    });

    expect(result).toEqual({
      boundingBoxX1: 20,
      boundingBoxY1: 370,
      boundingBoxX2: 40,
      boundingBoxY2: 390,
      imageWidth: 300,
      imageHeight: 400,
    });
  });

  const cases: [string, AssetEditActionItem[]][] = [
    ['rotate 90', [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }]],
    ['rotate 180', [{ action: AssetEditAction.Rotate, parameters: { angle: 180 } }]],
    ['rotate 270', [{ action: AssetEditAction.Rotate, parameters: { angle: 270 } }]],
    ['mirror', [{ action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } }]],
    [
      'crop, rotate and mirror',
      [
        { action: AssetEditAction.Crop, parameters: { x: 300, y: 400, width: 1800, height: 2000 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Vertical } },
      ],
    ],
  ];

  it.each(cases)('should return the same box when the stored face is shown again (%s)', (_, edits) => {
    const edited = getOutputDimensions(edits, original);
    const scale = 1440 / Math.max(edited.width, edited.height);
    const source = { width: Math.round(edited.width * scale), height: Math.round(edited.height * scale) };
    const box = { x1: 300, y1: 200, x2: 420, y2: 360 };

    const stored = transformEditedFaceToOriginal(box, edits, { source, edited, original });
    const shown = transformFaceBoundingBox(stored, edits, original);

    expect(shown.imageWidth).toBe(edited.width);
    expect(shown.imageHeight).toBe(edited.height);
    expect(shown.boundingBoxX1 * (source.width / edited.width)).toBeCloseTo(box.x1, -0.5);
    expect(shown.boundingBoxY1 * (source.height / edited.height)).toBeCloseTo(box.y1, -0.5);
    expect(shown.boundingBoxX2 * (source.width / edited.width)).toBeCloseTo(box.x2, -0.5);
    expect(shown.boundingBoxY2 * (source.height / edited.height)).toBeCloseTo(box.y2, -0.5);
  });
});

describe('transformOcrBoundingBox', () => {
  const baseOcr: AssetOcrResponseDto = {
    id: 'ocr-1',
    assetId: 'asset-1',
    x1: 0.1,
    y1: 0.1,
    x2: 0.2,
    y2: 0.1,
    x3: 0.2,
    y3: 0.2,
    x4: 0.1,
    y4: 0.2,
    boxScore: 0.9,
    textScore: 0.85,
    text: 'Test OCR',
  };

  const baseDimensions = { width: 1000, height: 800 };

  describe('with no edits', () => {
    it('should return unchanged bounding box', () => {
      const result = transformOcrBoundingBox(baseOcr, [], baseDimensions);
      expect(result).toEqual(baseOcr);
    });
  });

  describe('with crop edit', () => {
    it('should adjust normalized coordinates for crop', () => {
      const edits: AssetEditActionItem[] = [
        { action: AssetEditAction.Crop, parameters: { x: 100, y: 80, width: 400, height: 320 } },
      ];
      const result = transformOcrBoundingBox(baseOcr, edits, baseDimensions);

      // Original OCR: (0.1,0.1)-(0.2,0.2) on 1000x800 = (100,80)-(200,160)
      // After crop offset (100,80): (0,0)-(100,80)
      // Normalized to 400x320: (0,0)-(0.25,0.25)
      expect(result.x1).toBeCloseTo(0, 5);
      expect(result.y1).toBeCloseTo(0, 5);
      expect(result.x2).toBeCloseTo(0.25, 5);
      expect(result.y2).toBeCloseTo(0, 5);
      expect(result.x3).toBeCloseTo(0.25, 5);
      expect(result.y3).toBeCloseTo(0.25, 5);
      expect(result.x4).toBeCloseTo(0, 5);
      expect(result.y4).toBeCloseTo(0.25, 5);
    });
  });

  describe('with rotate edit', () => {
    it('should rotate normalized coordinates 90 degrees and reorder points', () => {
      const edits: AssetEditActionItem[] = [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }];
      const result = transformOcrBoundingBox(baseOcr, edits, baseDimensions);

      expect(result.id).toBe(baseOcr.id);
      expect(result.text).toBe(baseOcr.text);
      expect(result.x1).toBeCloseTo(0.8, 5);
      expect(result.y1).toBeCloseTo(0.1, 5);
      expect(result.x2).toBeCloseTo(0.9, 5);
      expect(result.y2).toBeCloseTo(0.1, 5);
      expect(result.x3).toBeCloseTo(0.9, 5);
      expect(result.y3).toBeCloseTo(0.2, 5);
      expect(result.x4).toBeCloseTo(0.8, 5);
      expect(result.y4).toBeCloseTo(0.2, 5);
    });

    it('should rotate 180 degrees and reorder points', () => {
      const edits: AssetEditActionItem[] = [{ action: AssetEditAction.Rotate, parameters: { angle: 180 } }];
      const result = transformOcrBoundingBox(baseOcr, edits, baseDimensions);

      expect(result.x1).toBeCloseTo(0.8, 5);
      expect(result.y1).toBeCloseTo(0.8, 5);
      expect(result.x2).toBeCloseTo(0.9, 5);
      expect(result.y2).toBeCloseTo(0.8, 5);
      expect(result.x3).toBeCloseTo(0.9, 5);
      expect(result.y3).toBeCloseTo(0.9, 5);
      expect(result.x4).toBeCloseTo(0.8, 5);
      expect(result.y4).toBeCloseTo(0.9, 5);
    });

    it('should rotate 270 degrees and reorder points', () => {
      const edits: AssetEditActionItem[] = [{ action: AssetEditAction.Rotate, parameters: { angle: 270 } }];
      const result = transformOcrBoundingBox(baseOcr, edits, baseDimensions);

      expect(result.id).toBe(baseOcr.id);
      expect(result.text).toBe(baseOcr.text);
      expect(result.x1).toBeCloseTo(0.1, 5);
      expect(result.y1).toBeCloseTo(0.8, 5);
      expect(result.x2).toBeCloseTo(0.2, 5);
      expect(result.y2).toBeCloseTo(0.8, 5);
      expect(result.x3).toBeCloseTo(0.2, 5);
      expect(result.y3).toBeCloseTo(0.9, 5);
      expect(result.x4).toBeCloseTo(0.1, 5);
      expect(result.y4).toBeCloseTo(0.9, 5);
    });
  });

  describe('with mirror edit', () => {
    it('should mirror horizontally', () => {
      const edits: AssetEditActionItem[] = [
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ];
      const result = transformOcrBoundingBox(baseOcr, edits, baseDimensions);

      expect(result.x1).toBeCloseTo(0.9, 5);
      expect(result.y1).toBeCloseTo(0.1, 5);
    });

    it('should mirror vertically', () => {
      const edits: AssetEditActionItem[] = [
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Vertical } },
      ];
      const result = transformOcrBoundingBox(baseOcr, edits, baseDimensions);

      expect(result.x1).toBeCloseTo(0.1, 5);
      expect(result.y1).toBeCloseTo(0.9, 5);
    });
  });

  describe('with combined edits', () => {
    it('should preserve OCR metadata through transforms', () => {
      const edits: AssetEditActionItem[] = [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 500, height: 400 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ];
      const result = transformOcrBoundingBox(baseOcr, edits, baseDimensions);

      expect(result.id).toBe(baseOcr.id);
      expect(result.assetId).toBe(baseOcr.assetId);
      expect(result.boxScore).toBe(baseOcr.boxScore);
      expect(result.textScore).toBe(baseOcr.textScore);
      expect(result.text).toBe(baseOcr.text);
    });
  });
});
