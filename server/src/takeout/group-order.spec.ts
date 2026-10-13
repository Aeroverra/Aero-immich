import { groupEdges, GroupOrderRow, orderGroups } from 'src/takeout/group-order';
import { describe, expect, it } from 'vitest';

const row = (over: Partial<GroupOrderRow> & { seq: number }): GroupOrderRow => ({
  groupIndex: null,
  dependsOnSeq: null,
  isCover: false,
  links: [],
  ...over,
});

describe('orderGroups', () => {
  it('keeps index order without dependencies', () => {
    expect(orderGroups([3, 1, 2], [])).toEqual([1, 2, 3]);
  });

  it('orders a dependency that lives in a later group first', () => {
    // group 0 holds an alreadyProcessed row whose source is in group 5
    const rows = [
      row({ seq: 0, groupIndex: 0, dependsOnSeq: 7 }),
      row({ seq: 7, groupIndex: 5 }),
      row({ seq: 8, groupIndex: 6 }),
    ];
    expect(orderGroups([0, 5, 6], groupEdges(rows))).toEqual([5, 0, 6]);
  });

  it('orders the target of a cover link first', () => {
    const rows = [row({ seq: 0, groupIndex: 1, isCover: true, links: [4] }), row({ seq: 4, groupIndex: 3 })];
    expect(orderGroups([1, 3], groupEdges(rows))).toEqual([3, 1]);
  });

  it('ignores links of members that are not the cover', () => {
    const rows = [row({ seq: 0, groupIndex: 1, isCover: false, links: [4] }), row({ seq: 4, groupIndex: 3 })];
    expect(groupEdges(rows)).toEqual([]);
  });

  it('drops self links and dependencies inside one group', () => {
    const rows = [
      row({ seq: 0, groupIndex: 2, isCover: true, links: [1] }),
      row({ seq: 1, groupIndex: 2, dependsOnSeq: 0 }),
    ];
    expect(groupEdges(rows)).toEqual([]);
    expect(orderGroups([2], groupEdges(rows))).toEqual([2]);
  });

  it('falls back to index order for a cycle', () => {
    const rows = [
      row({ seq: 0, groupIndex: 1, dependsOnSeq: 1 }),
      row({ seq: 1, groupIndex: 2, dependsOnSeq: 0 }),
      row({ seq: 2, groupIndex: 0 }),
    ];
    expect(orderGroups([0, 1, 2], groupEdges(rows))).toEqual([0, 1, 2]);
  });

  it('keeps ties stable by the smallest index', () => {
    // 9 -> 4 and 9 -> 2: 9 first, then 2 before 4
    expect(
      orderGroups(
        [4, 2, 9],
        [
          [9, 4],
          [9, 2],
        ],
      ),
    ).toEqual([9, 2, 4]);
  });
});
