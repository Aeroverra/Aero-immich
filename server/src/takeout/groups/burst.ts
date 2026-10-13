import { EditedPairTest, Emission, GroupItem, newGroup } from 'src/takeout/groups/group';

const FRAME_INTERVAL_MS = 500;

function sendBurstGroup<T extends GroupItem>(members: T[], out: Array<Emission<T>>, isEditedPair?: EditedPairTest<T>) {
  if (members.length === 0) {
    return;
  }
  if (members.length < 2) {
    out.push({ single: members[0] });
    return;
  }
  out.push({ group: newGroup(isEditedPair?.(members) ? 'other' : 'burst', members, 0) });
}

// Go burst.Group: frames less than 500 ms apart, used only when burstByTime is on and burst mode is not NoStack.
export function groupBursts<T extends GroupItem>(
  items: Iterable<T>,
  isEditedPair?: EditedPairTest<T>,
): Array<Emission<T>> {
  const out: Array<Emission<T>> = [];
  let current: T[] = [];
  let lastTaken: number | null = null;

  for (const item of items) {
    const dontGroupMe =
      item.type !== 'image' ||
      item.captureDate === null ||
      item.kind === 'burst' ||
      item.kind === 'edited' ||
      lastTaken === null ||
      Math.abs(item.captureDate - lastTaken) > FRAME_INTERVAL_MS;
    if (dontGroupMe) {
      sendBurstGroup(current, out, isEditedPair);
      current = [item];
    } else {
      current.push(item);
    }
    lastTaken = item.captureDate;
  }
  sendBurstGroup(current, out, isEditedPair);
  return out;
}
