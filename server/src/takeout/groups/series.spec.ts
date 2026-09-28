import { getInfo } from 'src/takeout/filenames/info-collector';
import { groupBursts } from 'src/takeout/groups/burst';
import { Emission, GroupItem } from 'src/takeout/groups/group';
import { groupSeries } from 'src/takeout/groups/series';
import { describe, expect, it } from 'vitest';

interface Named extends GroupItem {
  name: string;
}

const HOUR = 3_600_000;

function item(name: string, captureMs: number): Named {
  const info = getInfo(name, 'UTC');
  return {
    name,
    radical: info.radical,
    type: info.type,
    kind: info.kind,
    isCover: info.isCover,
    ext: info.ext,
    captureDate: captureMs,
    fileDate: captureMs,
  };
}

function sortedByRadicalThenDate(items: Named[]): Named[] {
  return [...items].sort((a, b) => (a.radical === b.radical ? a.captureDate! - b.captureDate! : a.radical < b.radical ? -1 : 1));
}

function collect(emissions: Array<Emission<Named>>) {
  const groups = emissions.filter((e): e is { group: import('src/takeout/groups/group').Group<Named> } => 'group' in e).map((e) => e.group);
  const singles = emissions.filter((e): e is { single: Named } => 'single' in e).map((e) => e.single.name);
  return { groups, singles };
}

// Ported from internal/groups/series series_test.go TestGroup (members compared as sets).
describe('groupSeries TestGroup', () => {
  it('forms a burst, a rawJpg and a heicJpg group and leaves the rest alone', () => {
    const items = [
      item('IMG_0001.jpg', 0),
      item('IMG_20231014_183246_BURST001_COVER.jpg', HOUR),
      item('IMG_20231014_183246_BURST002.jpg', HOUR),
      item('IMG_20231014_183246_BURST003.jpg', HOUR),
      item('IMG_0003.jpg', 2 * HOUR),
      item('IMG_0003.raw', 2 * HOUR),
      item('IMG_0004.heic', 3 * HOUR),
      item('IMG_0004.jpg', 3 * HOUR),
      item('IMG_0005.raw', 4 * HOUR),
      item('IMG_0006.heic', 4 * HOUR),
      item('IMG_0007.raw', 5 * HOUR),
      item('IMG_0007.jpg', 6 * HOUR),
      item('IMG_030.mp4', 140 * HOUR),
      item('IMG_030.mov', 150 * HOUR),
      item('IMG_030.jpg', 160 * HOUR),
      item('IMG_030.heic', 170 * HOUR),
    ];
    const { groups, singles } = collect(groupSeries(sortedByRadicalThenDate(items)));

    const byKind = new Map(groups.map((g) => [g.kind, new Set(g.members.map((m) => m.name))]));
    expect(groups).toHaveLength(3);
    expect(byKind.get('burst')).toEqual(new Set(['IMG_20231014_183246_BURST001_COVER.jpg', 'IMG_20231014_183246_BURST002.jpg', 'IMG_20231014_183246_BURST003.jpg']));
    expect(byKind.get('rawJpg')).toEqual(new Set(['IMG_0003.jpg', 'IMG_0003.raw']));
    expect(byKind.get('heicJpg')).toEqual(new Set(['IMG_0004.heic', 'IMG_0004.jpg']));
    expect(new Set(singles)).toEqual(
      new Set(['IMG_0001.jpg', 'IMG_0005.raw', 'IMG_0006.heic', 'IMG_0007.raw', 'IMG_0007.jpg', 'IMG_030.mp4', 'IMG_030.mov', 'IMG_030.jpg', 'IMG_030.heic']),
    );
  });
});

// Ported from series videopair_test.go TestGroupVideoPairs.
describe('groupSeries video pairs', () => {
  it('pairs VB and NS videos, leaves lone MAIN, saved copies and plain videos alone', () => {
    const base = 0;
    const items = [
      item('PXL_20250705_134305548.VB-02.MAIN.mp4', base),
      item('PXL_20250705_134305548.VB-01.COVER.mp4', base + 1500),
      item('PXL_20250803_113209979.NS-01.COVER.mp4', base + HOUR),
      item('PXL_20250803_113209979.NS-02.MAIN.mp4', base + HOUR),
      item('PXL_20260301_000301605.VB-02.MAIN.mp4', base + 2 * HOUR),
      item('PXL_20250726_093641990.VB-01.COVER.mp4', base + 3 * HOUR),
      item('PXL_20250726_093641990.VB-02.MAIN~2.mp4', base + 3 * HOUR),
      item('PXL_20231207_032111247.RAW-02.ORIGINAL.dng', base + 4 * HOUR),
      item('PXL_20231207_032111247.RAW-01.COVER.jpg', base + 4 * HOUR),
      item('PXL_20231208_100000000.mp4', base + 5 * HOUR),
      item('PXL_20231208_100000000.jpg', base + 5 * HOUR),
    ];
    const { groups, singles } = collect(groupSeries(sortedByRadicalThenDate(items)));

    const byRadical = new Map(groups.map((g) => [g.members[0].radical, g]));
    expect(groups).toHaveLength(3);
    for (const r of ['PXL_20250705_134305548', 'PXL_20250803_113209979']) {
      const g = byRadical.get(r)!;
      expect(g.kind).toBe('videoBoost');
      expect(g.members).toHaveLength(2);
      expect(g.members[g.coverIndex].isCover).toBe(false);
    }
    expect(byRadical.get('PXL_20231207_032111247')?.kind).toBe('rawJpg');
    expect(new Set(singles)).toEqual(
      new Set([
        'PXL_20260301_000301605.VB-02.MAIN.mp4',
        'PXL_20250726_093641990.VB-01.COVER.mp4',
        'PXL_20250726_093641990.VB-02.MAIN~2.mp4',
        'PXL_20231208_100000000.mp4',
        'PXL_20231208_100000000.jpg',
      ]),
    );
  });
});

// Ported from internal/groups/burst burst_test.go TestGroup (500 ms grouper).
describe('groupBursts 500 ms', () => {
  it('groups frames less than 500 ms apart', () => {
    const items: Named[] = [];
    const push = (i: number, ms: number): void => {
      items.push(item(`IMG_${String(i).padStart(3, '0')}.jpg`, ms));
    };
    push(1, 0);
    push(2, 200);
    push(3, 400);
    push(4, 600);
    push(5, 800);
    push(6, 1000);
    push(7, 1200);
    push(8, 1400);
    push(9, 1600);
    push(10, 5000);
    push(11, 10_000);
    push(12, 10_200);
    push(13, 10_400);
    push(14, 15_000);
    push(15, 20_000);
    push(16, 30_000);
    push(17, 30_200);
    push(18, 30_400);

    const { groups, singles } = collect(groupBursts(items));
    expect(groups.map((g) => g.members.length).sort((a, b) => a - b)).toEqual([3, 3, 9]);
    expect(new Set(singles)).toEqual(new Set(['IMG_010.jpg', 'IMG_014.jpg', 'IMG_015.jpg']));
  });
});
