import { PersonSuggestionKind } from 'src/enum';
import {
  getAnswerWeights,
  getFaceMatchScore,
  getSuggestionClass,
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

    it('should scale with the weight of the kind of question', () => {
      const question = { ...base, assets: 5, days: 3, latest: recent };
      expect(getSuggestionPriority({ ...question, weight: 2 })).toBeCloseTo(2 * getSuggestionPriority(question));
      expect(getSuggestionPriority({ ...question, weight: -1 })).toBe(0);
    });
  });

  describe(getSuggestionClass.name, () => {
    it('should tell faces, unnamed people and two unnamed people apart', () => {
      expect(getSuggestionClass(PersonSuggestionKind.Named, true)).toBe('face');
      expect(getSuggestionClass(PersonSuggestionKind.Named, false)).toBe('person');
      expect(getSuggestionClass(PersonSuggestionKind.Unnamed, false)).toBe('unnamed');
    });
  });

  describe(getAnswerWeights.name, () => {
    const named = PersonSuggestionKind.Named;
    const unnamed = PersonSuggestionKind.Unnamed;

    it('should weigh every kind the same without answers', () => {
      expect(getAnswerWeights([])).toEqual({ face: 1, person: 1, unnamed: 1 });
    });

    it('should put the kinds answered "same" more often than their scores promise first', () => {
      // 87 of 132 faces were the person, the scores promised 22; 11 of 77 pairs of unnamed people, 17 promised
      const weights = getAnswerWeights([
        { kind: named, isFace: true, same: 87, expected: 21.7 },
        { kind: unnamed, isFace: false, same: 11, expected: 17.2 },
      ]);
      expect(weights.face).toBeCloseTo((87 + 3) / (21.7 + 3));
      expect(weights.unnamed).toBeCloseTo((11 + 3) / (17.2 + 3));
      expect(weights.person).toBe(1);
      expect(weights.face).toBeGreaterThan(1);
      expect(weights.unnamed).toBeLessThan(1);
    });

    it('should move only a little after a few answers', () => {
      const { person } = getAnswerWeights([{ kind: named, isFace: false, same: 0, expected: 0.5 }]);
      expect(person).toBeCloseTo(3 / 3.5);
    });

    it('should add up rows of the same kind', () => {
      const { face } = getAnswerWeights(
        [
          { kind: named, isFace: true, same: 2, expected: 1 },
          { kind: named, isFace: true, same: 4, expected: 1 },
        ],
        0,
      );
      expect(face).toBe(3);
    });

    it('should be 1 without answers or a prior', () => {
      expect(getAnswerWeights([], 0)).toEqual({ face: 1, person: 1, unnamed: 1 });
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
