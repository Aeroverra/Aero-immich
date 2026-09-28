import { getInfo } from 'src/takeout/filenames/info-collector';
import { burstFilter, heicJpgFilter, parseVideoBoostMode, rawJpgFilter, videoBoostFilter } from 'src/takeout/filters';
import { Group, GroupItem, newGroup } from 'src/takeout/groups/group';
import { GroupKind } from 'src/takeout/types';
import { describe, expect, it } from 'vitest';

function item(name: string): GroupItem {
  const info = getInfo(name, 'UTC');
  return {
    radical: info.radical,
    type: info.type,
    kind: info.kind,
    isCover: info.isCover,
    ext: info.ext,
    captureDate: 0,
    fileDate: 0,
  };
}

function group(kind: GroupKind, names: string[], coverIndex = 0): Group<GroupItem> {
  return newGroup(
    kind,
    names.map((n) => item(n)),
    coverIndex,
  );
}

describe('burst filter', () => {
  it('NoStack ungroups', () => {
    expect(burstFilter('NoStack')(group('burst', ['a.jpg', 'b.jpg'])).kind).toBe('none');
  });
  it('other kinds untouched', () => {
    expect(burstFilter('NoStack')(group('other', ['a.jpg', 'b.jpg'])).kind).toBe('other');
  });
  it('StackKeepJPEG keeps only jpeg', () => {
    const g = burstFilter('StackKeepJPEG')(group('burst', ['photo1.raw', 'photo2.jpg']));
    expect(g.members.map((m) => m.ext)).toEqual(['.jpg']);
  });
  it('StackKeepRaw keeps only raw', () => {
    const g = burstFilter('StackKeepRaw')(group('burst', ['photo1.raw', 'photo2.jpg']));
    expect(g.members.map((m) => m.ext)).toEqual(['.raw']);
  });
});

describe('rawJpg filter', () => {
  it('NoStack ungroups', () => {
    expect(rawJpgFilter('NoStack')(group('rawJpg', ['a.jpg', 'a.raw'])).kind).toBe('none');
  });
  it('KeepRaw keeps raw and ungroups the single', () => {
    const g = rawJpgFilter('KeepRaw')(group('rawJpg', ['a.jpg', 'a.raw']));
    expect(g.kind).toBe('none');
    expect(g.members.map((m) => m.ext)).toEqual(['.raw']);
  });
  it('KeepJPG keeps jpg', () => {
    const g = rawJpgFilter('KeepJPG')(group('rawJpg', ['a.jpg', 'a.raw']));
    expect(g.members.map((m) => m.ext)).toEqual(['.jpg']);
  });
});

describe('heicJpg filter', () => {
  it('NoStack ungroups', () => {
    expect(heicJpgFilter('NoStack')(group('heicJpg', ['photo1.heic', 'photo2.jpg'])).kind).toBe('none');
  });
  it('KeepHeic keeps heic', () => {
    const g = heicJpgFilter('KeepHeic')(group('heicJpg', ['photo1.jpg', 'photo2.heic']));
    expect(g.members.map((m) => m.ext)).toEqual(['.heic']);
  });
  it('StackCoverHeic covers the heic wherever it sits', () => {
    expect(heicJpgFilter('StackCoverHeic')(group('heicJpg', ['photo1.heic', 'photo2.jpg'])).coverIndex).toBe(0);
    expect(heicJpgFilter('StackCoverHeic')(group('heicJpg', ['photo1.jpg', 'photo2.heic'])).coverIndex).toBe(1);
  });
  it('StackCoverJPG covers the jpg', () => {
    expect(heicJpgFilter('StackCoverJPG')(group('heicJpg', ['photo1.jpg', 'photo2.heic'])).coverIndex).toBe(0);
    expect(heicJpgFilter('StackCoverJPG')(group('heicJpg', ['photo1.heic', 'photo2.jpg'])).coverIndex).toBe(1);
  });
});

const vb = () =>
  group('videoBoost', ['PXL_20250705_134305548.VB-01.COVER.mp4', 'PXL_20250705_134305548.VB-02.MAIN.mp4']);

describe('videoBoost filter', () => {
  it('NoStack ungroups but keeps both', () => {
    const g = videoBoostFilter('NoStack')(vb());
    expect(g.kind).toBe('none');
    expect(g.members).toHaveLength(2);
  });
  it('Stack covers the MAIN', () => {
    const g = videoBoostFilter('Stack')(vb());
    expect(g.kind).toBe('videoBoost');
    expect(g.members[g.coverIndex].isCover).toBe(false);
  });
  it('KeepMain keeps only the MAIN', () => {
    const g = videoBoostFilter('KeepMain')(vb());
    expect(g.kind).toBe('none');
    expect(g.members).toHaveLength(1);
    expect(g.members[0].isCover).toBe(false);
    expect(g.removed).toHaveLength(1);
  });
  it('leaves other groups untouched', () => {
    for (const mode of ['NoStack', 'Stack', 'KeepMain'] as const) {
      const g = videoBoostFilter(mode)(group('rawJpg', ['IMG_0003.jpg', 'IMG_0003.dng']));
      expect(g.kind).toBe('rawJpg');
      expect(g.members).toHaveLength(2);
    }
  });
});

describe('VideoBoostFlag parsing', () => {
  it('parses values case-insensitively', () => {
    expect(parseVideoBoostMode('')).toBe('NoStack');
    expect(parseVideoBoostMode('NoStack')).toBe('NoStack');
    expect(parseVideoBoostMode('stack')).toBe('Stack');
    expect(parseVideoBoostMode('KEEPMAIN')).toBe('KeepMain');
    expect(() => parseVideoBoostMode('StackCoverCover')).toThrow();
  });
});
