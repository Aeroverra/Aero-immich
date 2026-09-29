import { assembleStackIds, dedupeTags, hasLocation } from 'src/services/takeout-asset';
import { describe, expect, it } from 'vitest';

describe('takeout-asset helpers', () => {
  describe('assembleStackIds', () => {
    it('keeps member order, appends smaller versions after their member, then links, dropping nulls and duplicates', () => {
      const ids = assembleStackIds(
        [
          { assetId: 'a', smallerAssetId: null },
          { assetId: 'b', smallerAssetId: 's' },
          { assetId: null, smallerAssetId: null },
        ],
        ['l', 'a', null],
      );
      expect(ids).toEqual(['a', 'b', 's', 'l']);
    });

    it('returns fewer than two ids when the group cannot form a stack', () => {
      expect(assembleStackIds([{ assetId: 'a', smallerAssetId: null }], [null])).toEqual(['a']);
    });
  });

  describe('dedupeTags', () => {
    it('keeps values verbatim, drops blanks and exact duplicates, keeps the first occurrence', () => {
      expect(dedupeTags(['People/Sue ', 'People/Sue', 'People/Sue ', '', '  ', 'takeout-1'])).toEqual([
        'People/Sue ',
        'People/Sue',
        'takeout-1',
      ]);
    });
  });

  describe('hasLocation', () => {
    it('is false at the zero island and true for a real location', () => {
      expect(hasLocation(0, 0)).toBe(false);
      expect(hasLocation(40.7, -74)).toBe(true);
    });
  });
});
