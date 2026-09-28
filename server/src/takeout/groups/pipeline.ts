import { groupBursts } from 'src/takeout/groups/burst';
import { EditedPairTest, Group, GroupItem, newGroup } from 'src/takeout/groups/group';
import { groupSeries } from 'src/takeout/groups/series';

// Go GrouperPipeline: [burst] then series, leftovers become single "none" groups. Go emits groups from
// concurrent goroutines; here the groups are ordered by the position of their first member in the input.
export function runGroupers<T extends GroupItem>(
  items: T[],
  options: { burst: boolean; isEditedPair?: EditedPairTest<T> },
): Array<Group<T>> {
  const position = new Map<T, number>();
  for (const [i, item] of items.entries()) {
    position.set(item, i);
  }

  const groups: Array<Group<T>> = [];
  let singles: T[] = items;
  if (options.burst) {
    singles = [];
    for (const emission of groupBursts(items, options.isEditedPair)) {
      if ('group' in emission) {
        groups.push(emission.group);
      } else {
        singles.push(emission.single);
      }
    }
  }
  for (const emission of groupSeries(singles, options.isEditedPair)) {
    groups.push('group' in emission ? emission.group : newGroup('none', [emission.single]));
  }
  return groups.sort((a, b) => (position.get(a.members[0]) ?? 0) - (position.get(b.members[0]) ?? 0));
}
