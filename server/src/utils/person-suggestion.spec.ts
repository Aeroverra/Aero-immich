import {
  getFaceMatchScore,
  getSuggestionPriority,
  getSuggestionScore,
  getTopMean,
  PERSON_SUGGESTION,
  pickTargets,
} from 'src/utils/person-suggestion';

const neighbor = (personGroupId: string, similarity: number) => ({ personGroupId, assetId: 'asset', similarity });

describe('person suggestion scoring', () => {
  describe(getTopMean.name, () => {
    it('should average the best values', () => {
      expect(getTopMean([0.1, 0.9, 0.5, 0.7], 2, 0)).toBeCloseTo(0.8);
    });

    it('should fill missing values', () => {
      expect(getTopMean([0.6], 3, 0.3)).toBeCloseTo(0.4);
    });

    it('should be 0 for no values wanted', () => {
      expect(getTopMean([0.6], 0, 0.3)).toBe(0);
    });
  });

  describe(getFaceMatchScore.name, () => {
    it('should average the best matches of each compared face', () => {
      const neighbors = [
        [neighbor('target', 0.7), neighbor('target', 0.6), neighbor('other', 0.2)],
        [neighbor('target', 0.5), neighbor('other', 0.4), neighbor('target', 0.3)],
      ];

      // two best of the target per face: (0.7 + 0.6) / 2 and (0.5 + 0.3) / 2
      expect(getFaceMatchScore(neighbors, 'target', 10, 2)).toBeCloseTo((0.65 + 0.4) / 2);
    });

    it('should take fewer matches when the target has fewer faces', () => {
      const neighbors = [[neighbor('target', 0.8), neighbor('other', 0.1)]];
      expect(getFaceMatchScore(neighbors, 'target', 1, 5)).toBeCloseTo(0.8);
    });

    it('should count target faces that were not among the nearest as the worst nearest one', () => {
      const neighbors = [[neighbor('target', 0.8), neighbor('other', 0.4)]];
      expect(getFaceMatchScore(neighbors, 'target', 10, 2)).toBeCloseTo((0.8 + 0.4) / 2);
    });

    it('should be 0 without compared faces', () => {
      expect(getFaceMatchScore([], 'target', 10)).toBe(0);
    });

    it('should never fill with a negative similarity', () => {
      const neighbors = [[neighbor('other', -0.2)]];
      expect(getFaceMatchScore(neighbors, 'target', 10, 2)).toBe(0);
    });
  });

  describe(getSuggestionScore.name, () => {
    it('should weigh face matches and averages the same', () => {
      expect(getSuggestionScore({ faceMatch: 0.4, centroid: 0.6, sharedAssetShare: 0 })).toBeCloseTo(0.5);
    });

    it('should lower the score when the target is already in the pictures', () => {
      expect(getSuggestionScore({ faceMatch: 0.4, centroid: 0.6, sharedAssetShare: 1 })).toBeCloseTo(
        0.5 - PERSON_SUGGESTION.sharedPenalty,
      );
    });
  });

  describe(getSuggestionPriority.name, () => {
    const now = new Date('2026-10-06T00:00:00Z');
    const recent = new Date('2026-09-01T00:00:00Z');
    const base = { score: 0.5, targetAssets: 20, now };

    it('should value more photos higher', () => {
      expect(getSuggestionPriority({ ...base, assets: 20, days: 2, latest: recent })).toBeGreaterThan(
        getSuggestionPriority({ ...base, assets: 2, days: 2, latest: recent }),
      );
    });

    it('should value more photos of the target higher', () => {
      expect(getSuggestionPriority({ ...base, targetAssets: 50, assets: 5, days: 2, latest: recent })).toBeGreaterThan(
        getSuggestionPriority({ ...base, targetAssets: 5, assets: 5, days: 2, latest: recent }),
      );
    });

    it('should not ask about a single face first because the target is on thousands of photos', () => {
      expect(getSuggestionPriority({ ...base, targetAssets: 20_000, assets: 1, days: 1, latest: recent })).toBeLessThan(
        getSuggestionPriority({ ...base, targetAssets: 10, assets: 15, days: 5, latest: recent }),
      );
    });

    it('should value someone seen on many days higher than in one crowd', () => {
      expect(getSuggestionPriority({ ...base, assets: 10, days: 10, latest: recent })).toBeGreaterThan(
        getSuggestionPriority({ ...base, assets: 10, days: 1, latest: recent }),
      );
    });

    it('should value recent photos higher', () => {
      expect(getSuggestionPriority({ ...base, assets: 5, days: 3, latest: recent })).toBeGreaterThan(
        getSuggestionPriority({ ...base, assets: 5, days: 3, latest: new Date('2010-01-01T00:00:00Z') }),
      );
    });

    it('should put likely pairs first, even somewhat smaller ones', () => {
      expect(getSuggestionPriority({ ...base, score: 0.7, assets: 5, days: 3, latest: recent })).toBeGreaterThan(
        getSuggestionPriority({ ...base, score: 0.4, assets: 12, days: 3, latest: recent }),
      );
    });
  });

  describe(pickTargets.name, () => {
    it('should pick the best target', () => {
      expect(pickTargets([{ score: 0.4 }, { score: 0.6 }])).toEqual([{ score: 0.6 }]);
    });

    it('should add a close runner-up', () => {
      expect(pickTargets([{ score: 0.55 }, { score: 0.6 }, { score: 0.5 }])).toEqual([{ score: 0.6 }, { score: 0.55 }]);
    });

    it('should handle no targets', () => {
      expect(pickTargets([])).toEqual([]);
    });
  });
});
