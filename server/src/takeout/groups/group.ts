import { NameKind } from 'src/takeout/filenames/name-info';
import { GroupKind } from 'src/takeout/types';

export interface GroupItem {
  radical: string;
  type: 'image' | 'video' | '';
  kind: NameKind;
  isCover: boolean;
  ext: string;
  // epoch milliseconds, null for Go's zero time
  captureDate: number | null;
  fileDate: number | null;
}

export interface Group<T> {
  kind: GroupKind;
  members: T[];
  coverIndex: number;
  removed: Array<{ item: T; reason: string }>;
}

export type Emission<T> = { group: Group<T> } | { single: T };

// DEV 4 hook: true when the members contain an edited copy and its original
export type EditedPairTest<T> = (members: T[]) => boolean;

export function newGroup<T>(kind: GroupKind, members: T[], coverIndex = 0): Group<T> {
  return { kind, members, coverIndex, removed: [] };
}

export function removeMember<T>(group: Group<T>, item: T, reason: string) {
  const i = group.members.indexOf(item);
  if (i !== -1) {
    group.removed.push({ item, reason });
    group.members.splice(i, 1);
  }
}
