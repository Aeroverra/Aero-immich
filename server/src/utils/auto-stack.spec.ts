import { AssetType, AssetVisibility } from 'src/enum';
import {
  AutoStackAsset,
  AutoStackFace,
  AutoStackOptions,
  AutoStackSkipReason,
  AutoStackSplitReason,
  getAutoStackPairSplitReason,
  getAutoStackSkipReason,
  getCosineDistance,
  groupAutoStackAssets,
  parseEmbedding,
  pickAutoStackPrimary,
  planAutoStackChanges,
  scoreAutoStackAssets,
} from 'src/utils/auto-stack';
import { describe, expect, it } from 'vitest';

const options: AutoStackOptions = {
  maxGapSeconds: 5,
  maxSpanSeconds: 30,
  maxAssets: 10,
  maxDistance: 0.06,
  maxFaceShift: 0.1,
  maxFaceSizeChange: 0.25,
  maxYawChange: 15,
};

const start = new Date('2024-10-30T12:00:00.000Z').getTime();

/** a 2d embedding at the given angle; two embeddings `a` and `b` degrees apart have a distance of 1 - cos(a - b) */
const embeddingAt = (degrees: number) => {
  const radians = (degrees * Math.PI) / 180;
  return parseEmbedding([Math.cos(radians), Math.sin(radians)]);
};

/** the angle between two embeddings with the given cosine distance */
const angleFor = (distance: number) => (Math.acos(1 - distance) * 180) / Math.PI;

const face = (overrides: Partial<AutoStackFace> = {}): AutoStackFace => ({
  personGroupId: 'person-1',
  imageWidth: 1000,
  imageHeight: 1000,
  boundingBoxX1: 400,
  boundingBoxY1: 400,
  boundingBoxX2: 600,
  boundingBoxY2: 600,
  detected: true,
  eyeBlinkLeft: 0.05,
  eyeBlinkRight: 0.05,
  smile: 0.5,
  yaw: 0,
  sharpness: 100,
  ...overrides,
});

let counter = 0;
const asset = (overrides: Partial<AutoStackAsset> & { seconds?: number } = {}): AutoStackAsset => {
  const { seconds = 0, ...rest } = overrides;
  counter++;
  return {
    id: `asset-${String(counter).padStart(3, '0')}`,
    capturedAt: new Date(start + seconds * 1000),
    originalFileName: `PXL_20241030_1200${String(counter).padStart(5, '0')}.jpg`,
    make: 'Google',
    model: 'Pixel 9 Pro XL',
    type: AssetType.Image,
    visibility: AssetVisibility.Timeline,
    isFavorite: false,
    embedding: embeddingAt(0),
    faces: [],
    sharpness: 100,
    exposureClipped: 0.01,
    isLocked: false,
    ...rest,
  };
};

const unknownPeople = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    face({ personGroupId: null, boundingBoxX1: index * 100, boundingBoxX2: index * 100 + 50 }),
  );

const ids = (assets: AutoStackAsset[]) => assets.map(({ id }) => id).sort();
const groupIds = (assets: AutoStackAsset[]) =>
  groupAutoStackAssets(assets, options).map(({ assetIds }) => [...assetIds].sort());

describe('auto stack', () => {
  describe('parseEmbedding', () => {
    it('should parse a pgvector string and normalize it', () => {
      const embedding = parseEmbedding('[3,4]')!;
      expect(embedding[0]).toBeCloseTo(0.6);
      expect(embedding[1]).toBeCloseTo(0.8);
    });

    it('should return null for a missing or zero embedding', () => {
      expect(parseEmbedding(null)).toBeNull();
      expect(parseEmbedding('[0,0]')).toBeNull();
    });

    it('should match the cosine distance of pgvector', () => {
      expect(getCosineDistance(embeddingAt(0)!, embeddingAt(angleFor(0.05))!)).toBeCloseTo(0.05);
    });
  });

  describe('getAutoStackSkipReason', () => {
    it('should accept a regular camera photo', () => {
      expect(getAutoStackSkipReason(asset())).toBeNull();
    });

    it.each([
      [{ type: AssetType.Video }, AutoStackSkipReason.NotImage],
      [{ visibility: AssetVisibility.Locked }, AutoStackSkipReason.Visibility],
      [{ visibility: AssetVisibility.Hidden }, AutoStackSkipReason.Visibility],
      [{ make: null }, AutoStackSkipReason.UnknownCamera],
      [{ model: null }, AutoStackSkipReason.UnknownCamera],
      [{ originalFileName: 'Screenshot_20241030-120000.png' }, AutoStackSkipReason.Screenshot],
      [{ originalFileName: 'Snapchat-123456789.jpg' }, AutoStackSkipReason.MessagingApp],
      [{ originalFileName: 'IMG-20241030-WA0001.jpg' }, AutoStackSkipReason.MessagingApp],
      [{ originalFileName: 'FB_IMG_1730289600000.jpg' }, AutoStackSkipReason.MessagingApp],
      [{ originalFileName: 'received_123456789.jpeg' }, AutoStackSkipReason.MessagingApp],
      [{ originalFileName: 'Messenger_creation_123.jpeg' }, AutoStackSkipReason.MessagingApp],
      [{ embedding: null }, AutoStackSkipReason.NoEmbedding],
      [{ isLocked: true }, AutoStackSkipReason.Locked],
    ])('should skip %o', (overrides, reason) => {
      expect(getAutoStackSkipReason(asset(overrides))).toBe(reason);
    });

    it('should accept archived photos', () => {
      expect(getAutoStackSkipReason(asset({ visibility: AssetVisibility.Archive }))).toBeNull();
    });
  });

  describe('groupAutoStackAssets', () => {
    it('should stack near-identical photos taken seconds apart', () => {
      const burst = [asset({ seconds: 0 }), asset({ seconds: 1 }), asset({ seconds: 2.5 })];
      expect(groupIds(burst)).toEqual([ids(burst)]);
    });

    it('should never return a single photo', () => {
      expect(groupAutoStackAssets([asset()], options)).toEqual([]);
      expect(groupAutoStackAssets([], options)).toEqual([]);
    });

    it('should split on a time gap between consecutive photos', () => {
      const first = [asset({ seconds: 0 }), asset({ seconds: 5 })];
      const second = [asset({ seconds: 10.5 }), asset({ seconds: 12 })];
      expect(groupIds([...first, ...second])).toEqual([ids(first), ids(second)]);
    });

    it('should accept a gap of exactly the maximum', () => {
      const burst = [asset({ seconds: 0 }), asset({ seconds: 5 })];
      expect(groupIds(burst)).toEqual([ids(burst)]);
    });

    it('should split a series that is longer than the span', () => {
      const series = Array.from({ length: 9 }, (_, index) => asset({ seconds: index * 4 }));
      // 0..28 s fit in 30 s, the photo at 32 s starts a new stack of its own
      expect(groupIds(series)).toEqual([ids(series.slice(0, 8))]);

      const longer = [...series, asset({ seconds: 34 })];
      expect(groupIds(longer)).toEqual([ids(series.slice(0, 8)), ids(longer.slice(8))]);
    });

    it('should cap a stack at the maximum number of photos', () => {
      const burst = Array.from({ length: 13 }, (_, index) => asset({ seconds: index * 0.5 }));
      expect(groupIds(burst)).toEqual([ids(burst.slice(0, 10)), ids(burst.slice(10))]);
    });

    it('should not mix cameras', () => {
      const pixel = [asset({ seconds: 0 }), asset({ seconds: 2 })];
      const iphone = [
        asset({ seconds: 1, make: 'Apple', model: 'iPhone 15' }),
        asset({ seconds: 3, make: 'Apple', model: 'iPhone 15' }),
      ];
      const groups = groupIds([pixel[0], iphone[0], pixel[1], iphone[1]]);
      expect(groups).toHaveLength(2);
      expect(groups).toEqual(expect.arrayContaining([ids(pixel), ids(iphone)]));
    });

    it('should use complete linkage instead of chaining similar neighbours', () => {
      const step = angleFor(0.04);
      const a = asset({ seconds: 0, embedding: embeddingAt(0) });
      const b = asset({ seconds: 1, embedding: embeddingAt(step) });
      // c is close to b but too far from a
      const c = asset({ seconds: 2, embedding: embeddingAt(step * 2) });
      expect(getCosineDistance(a.embedding!, c.embedding!)).toBeGreaterThan(options.maxDistance);
      expect(groupIds([a, b, c])).toEqual([ids([a, b])]);
    });

    it('should split photos that look different', () => {
      const a = asset({ seconds: 0, embedding: embeddingAt(0) });
      const b = asset({ seconds: 1, embedding: embeddingAt(angleFor(0.2)) });
      expect(groupIds([a, b])).toEqual([]);
      expect(getAutoStackPairSplitReason(a, b, options)).toBe(AutoStackSplitReason.LooksDifferent);
    });

    it('should end the open stack at a skipped photo', () => {
      const before = [asset({ seconds: 0 }), asset({ seconds: 1 })];
      const video = asset({ seconds: 2, type: AssetType.Video });
      const after = [asset({ seconds: 3 }), asset({ seconds: 4 })];
      expect(groupIds([...before, video, ...after])).toEqual([ids(before), ids(after)]);
    });

    it('should leave locked photos alone and split around them', () => {
      const a = asset({ seconds: 0 });
      const locked = asset({ seconds: 1, isLocked: true });
      const b = asset({ seconds: 2 });
      const c = asset({ seconds: 3 });
      expect(groupIds([a, locked, b, c])).toEqual([ids([b, c])]);
    });

    it('should skip screenshots, messaging app saves and unknown cameras', () => {
      const assets = [
        asset({ seconds: 0, originalFileName: 'Screenshot_1.png' }),
        asset({ seconds: 1, originalFileName: 'Screenshot_2.png' }),
        asset({ seconds: 2, originalFileName: 'IMG-20241030-WA0001.jpg' }),
        asset({ seconds: 3, originalFileName: 'IMG-20241030-WA0002.jpg' }),
        asset({ seconds: 4, make: null, model: null }),
        asset({ seconds: 5, make: null, model: null }),
      ];
      expect(groupIds(assets)).toEqual([]);
    });

    it('should not stack a timeline photo with an archived one', () => {
      const a = asset({ seconds: 0 });
      const b = asset({ seconds: 1, visibility: AssetVisibility.Archive });
      expect(groupIds([a, b])).toEqual([]);
    });

    it('should sort by capture time regardless of input order', () => {
      const burst = [asset({ seconds: 2 }), asset({ seconds: 0 }), asset({ seconds: 1 })];
      expect(groupIds(burst)).toEqual([ids(burst)]);
    });

    describe('people and pose', () => {
      it('should split when a person appears', () => {
        const a = asset({ seconds: 0, faces: [face()] });
        const b = asset({
          seconds: 1,
          faces: [face(), face({ personGroupId: 'person-2', boundingBoxX1: 100, boundingBoxX2: 200 })],
        });
        expect(groupIds([a, b])).toEqual([]);
        expect(getAutoStackPairSplitReason(a, b, options)).toBe(AutoStackSplitReason.PeopleChanged);
      });

      it('should split when a face appears in one photo only', () => {
        const a = asset({ seconds: 0, faces: [] });
        const b = asset({ seconds: 1, faces: [face({ personGroupId: null })] });
        expect(getAutoStackPairSplitReason(a, b, options)).toBe(AutoStackSplitReason.PeopleChanged);
      });

      it('should split when the recognized person differs', () => {
        const a = asset({ seconds: 0, faces: [face({ personGroupId: 'person-1' })] });
        const b = asset({ seconds: 1, faces: [face({ personGroupId: 'person-2' })] });
        expect(getAutoStackPairSplitReason(a, b, options)).toBe(AutoStackSplitReason.PeopleChanged);
      });

      it('should tolerate a different face count in large groups when the people match', () => {
        const a = asset({ seconds: 0, faces: unknownPeople(5) });
        const b = asset({ seconds: 1, faces: unknownPeople(6) });
        expect(getAutoStackPairSplitReason(a, b, options)).toBeNull();
      });

      it('should split when the largest face moves', () => {
        const a = asset({ seconds: 0, faces: [face()] });
        const b = asset({ seconds: 1, faces: [face({ boundingBoxX1: 520, boundingBoxX2: 720 })] });
        expect(getAutoStackPairSplitReason(a, b, options)).toBe(AutoStackSplitReason.FaceMoved);
        expect(groupIds([a, b])).toEqual([]);
      });

      it('should keep a slightly moved face', () => {
        const a = asset({ seconds: 0, faces: [face()] });
        const b = asset({ seconds: 1, faces: [face({ boundingBoxX1: 450, boundingBoxX2: 650 })] });
        expect(getAutoStackPairSplitReason(a, b, options)).toBeNull();
      });

      it('should split when the largest face changes size', () => {
        const a = asset({ seconds: 0, faces: [face()] });
        const b = asset({
          seconds: 1,
          faces: [face({ boundingBoxX1: 360, boundingBoxY1: 360, boundingBoxX2: 640, boundingBoxY2: 640 })],
        });
        expect(getAutoStackPairSplitReason(a, b, options)).toBe(AutoStackSplitReason.FaceSizeChanged);
      });

      it('should split when the head turns', () => {
        const a = asset({ seconds: 0, faces: [face({ yaw: -5 })] });
        const b = asset({ seconds: 1, faces: [face({ yaw: 12 })] });
        expect(getAutoStackPairSplitReason(a, b, options)).toBe(AutoStackSplitReason.HeadTurned);
      });

      it('should ignore yaw of faces without landmarks', () => {
        const a = asset({ seconds: 0, faces: [face({ yaw: -30, detected: false })] });
        const b = asset({ seconds: 1, faces: [face({ yaw: 30 })] });
        expect(getAutoStackPairSplitReason(a, b, options)).toBeNull();
      });

      it('should split a selfie session into poses', () => {
        const pose1 = [asset({ seconds: 0, faces: [face()] }), asset({ seconds: 1, faces: [face({ yaw: 3 })] })];
        const pose2 = [
          asset({ seconds: 2, faces: [face({ yaw: 25 })] }),
          asset({ seconds: 3, faces: [face({ yaw: 28 })] }),
        ];
        expect(groupIds([...pose1, ...pose2])).toEqual([ids(pose1), ids(pose2)]);
      });
    });

    it('should put the top pick first', () => {
      const a = asset({ seconds: 0, sharpness: 10 });
      const b = asset({ seconds: 1, sharpness: 200 });
      const c = asset({ seconds: 2, sharpness: 50 });
      const [group] = groupAutoStackAssets([a, b, c], options);
      expect(group.assetIds).toEqual([b.id, a.id, c.id]);
    });
  });

  describe('scoreAutoStackAssets', () => {
    it('should let a favorite win', () => {
      const sharp = asset({ seconds: 0, sharpness: 500 });
      const favorite = asset({ seconds: 1, sharpness: 1, exposureClipped: 0.5, isFavorite: true });
      expect(pickAutoStackPrimary([sharp, favorite])).toBe(favorite.id);
    });

    it('should let a favorite win over open eyes', () => {
      const open = asset({ seconds: 0, faces: [face()] });
      const favorite = asset({
        seconds: 1,
        isFavorite: true,
        faces: [face({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 })],
      });
      expect(pickAutoStackPrimary([open, favorite])).toBe(favorite.id);
    });

    it('should penalize closed eyes', () => {
      const closed = asset({
        seconds: 0,
        sharpness: 900,
        faces: [face({ eyeBlinkLeft: 0.8, sharpness: 900, smile: 1 })],
      });
      const open = asset({
        seconds: 1,
        sharpness: 100,
        faces: [face({ eyeBlinkLeft: 0.1, sharpness: 100, smile: 0 })],
      });
      const scores = scoreAutoStackAssets([closed, open]);
      expect(scores.get(closed.id)!).toBeLessThan(0);
      expect(pickAutoStackPrimary([closed, open])).toBe(open.id);
    });

    it('should penalize when any face in a group photo blinks', () => {
      const other = { personGroupId: 'person-2', boundingBoxX1: 100, boundingBoxX2: 250 };
      const oneBlinks = asset({ seconds: 0, faces: [face(), face({ ...other, eyeBlinkRight: 0.7 })] });
      const allOpen = asset({ seconds: 1, faces: [face({ smile: 0 }), face({ ...other, smile: 0 })] });
      expect(pickAutoStackPrimary([oneBlinks, allOpen])).toBe(allOpen.id);
    });

    it('should prefer a smile and a frontal face', () => {
      const neutral = asset({ seconds: 0, faces: [face({ smile: 0.1, yaw: 10 })] });
      const smiling = asset({ seconds: 1, faces: [face({ smile: 0.9, yaw: 2 })] });
      expect(pickAutoStackPrimary([neutral, smiling])).toBe(smiling.id);
    });

    it('should prefer the sharper face', () => {
      const blurry = asset({ seconds: 0, faces: [face({ sharpness: 10 })] });
      const sharp = asset({ seconds: 1, faces: [face({ sharpness: 300 })] });
      expect(pickAutoStackPrimary([blurry, sharp])).toBe(sharp.id);
    });

    it('should use neutral values for faces without landmarks', () => {
      const unread = asset({ seconds: 0, faces: [face({ detected: false, eyeBlinkLeft: null, eyeBlinkRight: null })] });
      const read = asset({ seconds: 1, faces: [face({ eyeBlinkLeft: 0.02, eyeBlinkRight: 0.02 })] });
      const scores = scoreAutoStackAssets([unread, read]);
      expect(scores.get(unread.id)).toBeCloseTo(
        0.35 * 0.5 + 0.15 * 0.3 + 0.2 * 0.5 + 0.1 * 0.5 + 0.1 * 0.5 + 0.05 * 0.5 + 0.05 * 0.5,
      );
      expect(pickAutoStackPrimary([unread, read])).toBe(read.id);
    });

    it('should rank photos without faces by sharpness, exposure and closeness to the middle', () => {
      const photos = [
        asset({ seconds: 0, sharpness: 100, exposureClipped: 0.1 }),
        asset({ seconds: 1, sharpness: 100, exposureClipped: 0.1 }),
        asset({ seconds: 2, sharpness: 100, exposureClipped: 0.1 }),
      ];
      // identical sharpness and exposure: the middle photo wins
      expect(pickAutoStackPrimary(photos)).toBe(photos[1].id);

      photos[2].sharpness = 400;
      expect(pickAutoStackPrimary(photos)).toBe(photos[2].id);

      const scores = scoreAutoStackAssets(photos);
      expect(scores.get(photos[2].id)).toBeCloseTo(0.6 + 0.25 * 0.5 + 0);
    });

    it('should use the no-face path when only some photos have faces', () => {
      const withFace = asset({ seconds: 0, sharpness: 10, faces: [face()] });
      const withoutFace = asset({ seconds: 1, sharpness: 20 });
      expect(pickAutoStackPrimary([withFace, withoutFace])).toBe(withoutFace.id);
    });

    it('should cope with missing quality values', () => {
      const photos = [
        asset({ seconds: 0, sharpness: null, exposureClipped: null }),
        asset({ seconds: 1, sharpness: null, exposureClipped: null }),
      ];
      // a tie goes to the earliest photo
      expect(pickAutoStackPrimary(photos)).toBe(photos[0].id);

      // a measured photo beats one that was not measured yet
      photos[1].sharpness = 5;
      expect(pickAutoStackPrimary(photos)).toBe(photos[1].id);
    });
  });

  describe('planAutoStackChanges', () => {
    it('should create new groups', () => {
      expect(planAutoStackChanges([{ assetIds: ['a', 'b'] }], [])).toEqual({
        create: [{ assetIds: ['a', 'b'] }],
        delete: [],
        update: [],
      });
    });

    it('should keep an identical stack', () => {
      expect(
        planAutoStackChanges(
          [{ assetIds: ['a', 'b'] }],
          [{ id: 'stack-1', primaryAssetId: 'a', assetIds: ['b', 'a'] }],
        ),
      ).toEqual({ create: [], delete: [], update: [] });
    });

    it('should move the cover to the new top pick', () => {
      expect(
        planAutoStackChanges(
          [{ assetIds: ['b', 'a'] }],
          [{ id: 'stack-1', primaryAssetId: 'a', assetIds: ['a', 'b'] }],
        ),
      ).toEqual({ create: [], delete: [], update: [{ id: 'stack-1', primaryAssetId: 'b' }] });
    });

    it('should replace a stack whose members changed', () => {
      expect(
        planAutoStackChanges(
          [{ assetIds: ['a', 'b', 'c'] }],
          [{ id: 'stack-1', primaryAssetId: 'a', assetIds: ['a', 'b'] }],
        ),
      ).toEqual({ create: [{ assetIds: ['a', 'b', 'c'] }], delete: ['stack-1'], update: [] });
    });

    it('should delete stacks that no longer form a group', () => {
      expect(planAutoStackChanges([], [{ id: 'stack-1', primaryAssetId: 'a', assetIds: ['a', 'b'] }])).toEqual({
        create: [],
        delete: ['stack-1'],
        update: [],
      });
    });
  });
});
