import type { TagResponseDto } from '@immich/sdk';
import { buildTagRows, groupTagsByParent, pickTagRow, tagName, tagParentPath } from '$lib/utils/tag-tree';

const newTag = (value: string): TagResponseDto => ({
  id: value,
  value,
  name: value.split('/').at(-1)!,
  isHidden: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('tag tree', () => {
  const tags = [
    'Food',
    'Food/Dessert',
    'Food/Dessert/Cake',
    'Food/Dessert/Chocolate Ice Cream',
    'Food/Drinks',
    'Food/Drinks/Hot Chocolate',
    'Trip 10',
    'Trip 9',
  ].map(newTag);
  const none = new Set<string>();

  it('splits paths', () => {
    expect(tagName('Food/Drinks/Hot Chocolate')).toBe('Hot Chocolate');
    expect(tagParentPath('Food/Drinks/Hot Chocolate')).toBe('Food/Drinks');
    expect(tagParentPath('Food')).toBe('');
  });

  it('lists the top level sorted by name, numbers in order, until a tag is opened', () => {
    const rows = buildTagRows(tags, { expanded: none, checked: none });
    expect(rows.map((row) => row.name)).toEqual(['Food', 'Trip 9', 'Trip 10']);
    expect(rows[0]).toMatchObject({ hasChildren: true, isOpen: false, depth: 0 });
  });

  it('shows the children of open tags with their depth', () => {
    const rows = buildTagRows(tags, { expanded: new Set(['Food', 'Food/Drinks']), checked: none });
    expect(rows.map((row) => `${row.depth}:${row.name}`)).toEqual([
      '0:Food',
      '1:Dessert',
      '1:Drinks',
      '2:Hot Chocolate',
      '0:Trip 9',
      '0:Trip 10',
    ]);
  });

  it('counts the checked tags below each tag', () => {
    const checked = new Set(['Food/Dessert/Cake', 'Food/Drinks/Hot Chocolate']);
    const rows = buildTagRows(tags, { expanded: new Set(['Food']), checked });
    const below = Object.fromEntries(rows.map((row) => [row.tag.value, row.checkedBelow]));
    expect(below).toEqual({ Food: 2, 'Food/Dessert': 1, 'Food/Drinks': 1, 'Trip 9': 0, 'Trip 10': 0 });
  });

  it('shows matches with their parents while searching, whatever is open', () => {
    const rows = buildTagRows(tags, { expanded: none, checked: none, query: 'chocolate' });
    expect(rows.map((row) => [row.tag.value, row.isMatch])).toEqual([
      ['Food', false],
      ['Food/Dessert', false],
      ['Food/Dessert/Chocolate Ice Cream', true],
      ['Food/Drinks', false],
      ['Food/Drinks/Hot Chocolate', true],
    ]);
    const words = buildTagRows(tags, { expanded: none, checked: none, query: 'hot choc' });
    expect(words.filter((row) => row.isMatch).map((row) => row.tag.value)).toEqual(['Food/Drinks/Hot Chocolate']);
  });

  it('lists a tag whose parent is missing at the top level with its full path', () => {
    const rows = buildTagRows([newTag('Hidden/Child'), newTag('Other')], { expanded: none, checked: none });
    expect(rows.map((row) => row.name)).toEqual(['Hidden/Child', 'Other']);
  });

  it('picks the exact path, then the exact name, then the first match', () => {
    const search = (query: string) =>
      pickTagRow(buildTagRows(tags, { expanded: none, checked: none, query }), query)?.tag.value;
    expect(search('food/drinks')).toBe('Food/Drinks');
    expect(search('cake')).toBe('Food/Dessert/Cake');
    expect(search('chocolate')).toBe('Food/Dessert/Chocolate Ice Cream');
    expect(search('nothing')).toBeUndefined();
  });

  it('groups tags under their parent path, top level first', () => {
    const groups = groupTagsByParent([
      newTag('Food/Dessert/Chocolate Ice Cream'),
      newTag('Trip 9'),
      newTag('Food/Drinks/Hot Chocolate'),
      newTag('Food/Dessert/Cake'),
    ]);
    expect(groups.map((group) => [group.parent, group.tags.map((tag) => tagName(tag.value))])).toEqual([
      ['', ['Trip 9']],
      ['Food/Dessert', ['Cake', 'Chocolate Ice Cream']],
      ['Food/Drinks', ['Hot Chocolate']],
    ]);
  });
});
