import type { TagResponseDto } from '@immich/sdk';
import { getViewDeparture } from '$lib/utils/view-departures';

const newTag = (value: string): TagResponseDto => ({
  id: value,
  value,
  name: value.split('/').at(-1)!,
  isHidden: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const tags = ['Food', 'Food/Dessert', 'Food/Dessert/Cake', 'Food/Fruit', 'Travel', 'Review'].map((value) =>
  newTag(value),
);
const allBut = (...excludeTagIds: string[]) => ({
  includeAll: true,
  includeUntagged: false,
  includeTagIds: [],
  excludeTagIds,
});
const only = (includeTagIds: string[], includeUntagged = false) => ({
  includeAll: false,
  includeUntagged,
  includeTagIds,
  excludeTagIds: [],
});

describe('getViewDeparture', () => {
  it('keeps every asset without a view', () => {
    expect(getViewDeparture(null, tags, { addIds: ['Travel'], removeIds: [] })).toBe('none');
  });

  it('takes every asset out of a view that excludes the added tag', () => {
    expect(getViewDeparture(allBut('Travel'), tags, { addIds: ['Travel'], removeIds: [] })).toBe('all');
  });

  it('takes every asset out of a view that excludes a parent of the added tag', () => {
    expect(getViewDeparture(allBut('Food'), tags, { addIds: ['Food/Dessert/Cake'], removeIds: [] })).toBe('all');
  });

  it('does not treat a tag whose name only starts like an excluded one as its child', () => {
    const foodie = [...tags, newTag('Foodie')];
    expect(getViewDeparture(allBut('Food'), foodie, { addIds: ['Foodie'], removeIds: [] })).toBe('none');
  });

  it('keeps the assets when an excluded tag is taken off or another tag is added', () => {
    expect(getViewDeparture(allBut('Travel'), tags, { addIds: ['Food'], removeIds: ['Travel'] })).toBe('none');
  });

  it('cannot tell which assets leave when an include tag is taken off', () => {
    expect(getViewDeparture(only(['Review']), tags, { addIds: [], removeIds: ['Review'] })).toBe('unknown');
    expect(getViewDeparture(only(['Food']), tags, { addIds: [], removeIds: ['Food/Fruit'] })).toBe('unknown');
  });

  it('keeps the assets of an include view when an included tag is added', () => {
    expect(getViewDeparture(only(['Food'], true), tags, { addIds: ['Food/Fruit'], removeIds: [] })).toBe('none');
  });

  it('cannot tell which assets leave an untagged view when another tag is added', () => {
    expect(getViewDeparture(only([], true), tags, { addIds: ['Travel'], removeIds: [] })).toBe('unknown');
  });
});
