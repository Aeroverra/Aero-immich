import {
  DetailPanelSection,
  defaultDetailPanelSections,
  getDetailPanelSectionOrder,
  getHiddenDetailPanelSections,
  moveDetailPanelSection,
  toDetailPanelSettings,
} from '$lib/utils/detail-panel-sections';

describe('detail panel sections', () => {
  describe('getDetailPanelSectionOrder', () => {
    it('uses the default order when nothing is saved', () => {
      expect(getDetailPanelSectionOrder([])).toEqual(defaultDetailPanelSections);
      expect(getDetailPanelSectionOrder(undefined)).toEqual(defaultDetailPanelSections);
    });

    it('keeps the saved order', () => {
      const saved = [DetailPanelSection.Tags, ...defaultDetailPanelSections.filter((id) => id !== 'tags')];
      expect(getDetailPanelSectionOrder(saved)).toEqual(saved);
    });

    it('puts sections the saved order does not know after their default neighbor', () => {
      const saved = ['tags', 'description', 'rating', 'people', 'details', 'map', 'shared-by', 'albums'];

      expect(getDetailPanelSectionOrder(saved)).toEqual([
        DetailPanelSection.Tags,
        DetailPanelSection.Description,
        DetailPanelSection.Rating,
        DetailPanelSection.Bookmarks,
        DetailPanelSection.People,
        DetailPanelSection.Details,
        DetailPanelSection.Map,
        DetailPanelSection.SharedBy,
        DetailPanelSection.Albums,
        DetailPanelSection.Metadata,
      ]);
    });

    it('puts a missing first section at the top', () => {
      const saved = defaultDetailPanelSections.filter((id) => id !== DetailPanelSection.Description).reverse();
      const order = getDetailPanelSectionOrder(saved);

      expect(order[0]).toBe(DetailPanelSection.Description);
      expect(order).toHaveLength(defaultDetailPanelSections.length);
    });

    it('skips unknown and repeated ids and ignores broken settings', () => {
      expect(getDetailPanelSectionOrder(['gone', 'tags', 'description', 'tags'])).toEqual([
        DetailPanelSection.Tags,
        ...defaultDetailPanelSections.filter((id) => id !== DetailPanelSection.Tags),
      ]);
      expect(getDetailPanelSectionOrder('tags')).toEqual(defaultDetailPanelSections);
      expect(getDetailPanelSectionOrder({ tags: 1 })).toEqual(defaultDetailPanelSections);
    });
  });

  describe('getHiddenDetailPanelSections', () => {
    it('reads the hidden ids', () => {
      expect(getHiddenDetailPanelSections(['map', 'albums'])).toEqual(new Set(['map', 'albums']));
      expect(getHiddenDetailPanelSections(null)).toEqual(new Set());
    });
  });

  describe('moveDetailPanelSection', () => {
    it('moves a section and keeps the others in order', () => {
      const order = moveDetailPanelSection(defaultDetailPanelSections, DetailPanelSection.Tags, 0);

      expect(order[0]).toBe(DetailPanelSection.Tags);
      expect(order.slice(1)).toEqual(defaultDetailPanelSections.filter((id) => id !== DetailPanelSection.Tags));
    });

    it('moves down', () => {
      const order = moveDetailPanelSection(defaultDetailPanelSections, DetailPanelSection.Description, 1);
      expect(order.slice(0, 2)).toEqual([DetailPanelSection.Rating, DetailPanelSection.Description]);
    });

    it('clamps the target index and returns the same order when nothing moves', () => {
      expect(moveDetailPanelSection(defaultDetailPanelSections, DetailPanelSection.Description, -1)).toBe(
        defaultDetailPanelSections,
      );
      expect(moveDetailPanelSection(defaultDetailPanelSections, DetailPanelSection.Tags, 99)).toBe(
        defaultDetailPanelSections,
      );
    });
  });

  describe('toDetailPanelSettings', () => {
    it('stores the default order as an empty list', () => {
      expect(toDetailPanelSettings([...defaultDetailPanelSections], ['map', 'map'])).toEqual({
        order: [],
        hidden: ['map'],
      });
    });

    it('stores a custom order', () => {
      const order = moveDetailPanelSection(defaultDetailPanelSections, DetailPanelSection.Tags, 0);
      expect(toDetailPanelSettings(order, [])).toEqual({ order, hidden: [] });
    });
  });
});
