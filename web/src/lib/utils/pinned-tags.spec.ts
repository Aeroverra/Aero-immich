import type { TagResponseDto } from '@immich/sdk';
import { getPinnedTags, getTagCoverage, nextTagChange, togglePinnedTag } from '$lib/utils/pinned-tags';

const newTag = (value: string): TagResponseDto => ({
  id: value,
  value,
  name: value.split('/').at(-1)!,
  isHidden: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('pinned tags', () => {
  describe('togglePinnedTag', () => {
    it('pins a tag after the ones pinned before', () => {
      expect(togglePinnedTag(['a'], 'b')).toEqual(['a', 'b']);
    });

    it('unpins a pinned tag', () => {
      expect(togglePinnedTag(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    });
  });

  describe('getPinnedTags', () => {
    it('keeps the pin order and leaves out deleted tags', () => {
      const tags = [newTag('Food'), newTag('Food/Dessert'), newTag('Food/Dessert/Cake')];
      expect(getPinnedTags(['Food/Dessert/Cake', 'gone', 'Food'], tags).map(({ id }) => id)).toEqual([
        'Food/Dessert/Cake',
        'Food',
      ]);
    });
  });

  describe('getTagCoverage', () => {
    it('tells whether all, some or none of the assets carry the tag', () => {
      expect(getTagCoverage(3, 3)).toBe('all');
      expect(getTagCoverage(1, 3)).toBe('some');
      expect(getTagCoverage(0, 3)).toBe('none');
    });

    it('counts nothing as all of an empty selection', () => {
      expect(getTagCoverage(0, 0)).toBe('none');
    });
  });

  describe('nextTagChange', () => {
    it('takes a tag all assets carry off, and undoes that on the next click', () => {
      expect(nextTagChange(undefined, 'all')).toBe(false);
      expect(nextTagChange(false, 'all')).toBeUndefined();
    });

    it('adds a tag no asset carries, and undoes that on the next click', () => {
      expect(nextTagChange(undefined, 'none')).toBe(true);
      expect(nextTagChange(true, 'none')).toBeUndefined();
    });

    it('goes from add to all, to take off all, back to unchanged for a tag some assets carry', () => {
      expect(nextTagChange(undefined, 'some')).toBe(true);
      expect(nextTagChange(true, 'some')).toBe(false);
      expect(nextTagChange(false, 'some')).toBeUndefined();
    });

    it('undoes a change kept from an earlier selection that the new one already matches', () => {
      expect(nextTagChange(true, 'all')).toBeUndefined();
      expect(nextTagChange(false, 'none')).toBeUndefined();
    });
  });
});
