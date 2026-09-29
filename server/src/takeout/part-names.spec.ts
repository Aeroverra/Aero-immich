import { groupExports, parsePartName, takeoutTagName } from 'src/takeout/part-names';
import { FolderFile } from 'src/takeout/types';
import { describe, expect, it } from 'vitest';

function file(name: string, size = 1000): FolderFile {
  return { fileName: name, size, mtime: new Date('2026-09-14T00:00:00Z'), ctime: new Date('2026-09-14T00:00:00Z') };
}

describe('parsePartName', () => {
  it('parses a segmented tgz part', () => {
    expect(parsePartName('takeout-20260914T211500Z-1-001.tgz')).toMatchObject({
      timestamp: '20260914T211500Z',
      segment: 1,
      partNumber: 1,
      kind: 'tgz',
    });
  });
  it('parses a non-segmented zip part and tar.gz', () => {
    expect(parsePartName('takeout-20260915T001353Z-001.zip')).toMatchObject({
      segment: null,
      partNumber: 1,
      kind: 'zip',
    });
    expect(parsePartName('takeout-20260915T001353Z-001.tar.gz')?.kind).toBe('tgz');
  });
  it('rejects non-part names', () => {
    expect(parsePartName('photo.jpg')).toBeNull();
    expect(parsePartName('takeout-20260914T211500Z-1-001.part')).toBeNull();
  });
});

describe('takeoutTagName', () => {
  it('strips the extension and trailing -NNN', () => {
    expect(takeoutTagName('takeout-20260914T211500Z-1-001.tgz')).toBe('takeout-20260914T211500Z-1');
    expect(takeoutTagName('takeout-20260915T001353Z-001.tgz')).toBe('takeout-20260915T001353Z');
  });
});

describe('groupExports', () => {
  it('groups the 5 real parts into one export with the index attached', () => {
    const names = [
      'takeout-20260914T211500Z-1-001.tgz',
      'takeout-20260914T211500Z-1-002.tgz',
      'takeout-20260915T050420Z-1-003.tgz',
      'takeout-20260915T050420Z-1-004.tgz',
      'takeout-20260915T050420Z-1-005.tgz',
      'takeout-20260915T001353Z-001.tgz',
    ];
    const { exports, orphanIndexes, otherFiles } = groupExports(
      names.map((n) => file(n)),
      new Set(),
      new Set(),
    );
    expect(otherFiles).toEqual([]);
    expect(orphanIndexes).toEqual([]);
    expect(exports).toHaveLength(1);
    const media = exports[0].parts.filter((p) => !p.isIndex);
    const index = exports[0].parts.filter((p) => p.isIndex);
    expect(media).toHaveLength(5);
    expect(index).toHaveLength(1);
    expect(exports[0].parts.at(-1)?.isIndex).toBe(true);
    expect(exports[0].exportKey).toBe('20260914T211500Z-1');
  });

  it('keeps the index of a segmented export that shares the timestamp of its data parts (family folder)', () => {
    // export A: 15 data parts, its index 1 s earlier; export B (another account): 2 data parts, its index at the
    // same second. B's index used to count as a data part and was chained onto A.
    const a = Array.from({ length: 15 }, (_, i) => `takeout-20260928T015749Z-1-${String(i + 1).padStart(3, '0')}.tgz`);
    const names = [
      ...a,
      'takeout-20260928T015748Z-001.tgz',
      'takeout-20260928T025618Z-1-001.tgz',
      'takeout-20260928T025618Z-1-002.tgz',
      'takeout-20260928T025618Z-001.tgz',
    ];
    const { exports, orphanIndexes } = groupExports(
      names.map((n) => file(n)),
      new Set(),
      new Set(),
    );
    expect(orphanIndexes).toEqual([]);
    expect(exports).toHaveLength(2);
    const [exportA, exportB] = exports;
    expect(exportA.exportKey).toBe('20260928T015749Z-1');
    expect(exportA.parts.filter((p) => !p.isIndex).map((p) => p.fileName)).toEqual(a);
    expect(exportA.parts.filter((p) => p.isIndex).map((p) => p.fileName)).toEqual(['takeout-20260928T015748Z-001.tgz']);
    expect(exportB.exportKey).toBe('20260928T025618Z-1');
    expect(exportB.parts.filter((p) => !p.isIndex).map((p) => p.fileName)).toEqual([
      'takeout-20260928T025618Z-1-001.tgz',
      'takeout-20260928T025618Z-1-002.tgz',
    ]);
    expect(exportB.parts.filter((p) => p.isIndex).map((p) => p.fileName)).toEqual(['takeout-20260928T025618Z-001.tgz']);
  });

  it('still reads -001 as a data part when a segment-less -002 shares its timestamp', () => {
    const names = ['takeout-20260101T000000Z-001.zip', 'takeout-20260101T000000Z-002.zip'];
    const { exports, orphanIndexes } = groupExports(
      names.map((n) => file(n)),
      new Set(),
      new Set(),
    );
    expect(orphanIndexes).toEqual([]);
    expect(exports).toHaveLength(1);
    expect(exports[0].parts.map((p) => [p.partNumber, p.isIndex])).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  it('splits two exports whose part numbers restart', () => {
    const names = [
      'takeout-20260101T000000Z-1-001.tgz',
      'takeout-20260101T000000Z-1-002.tgz',
      'takeout-20260201T000000Z-1-001.tgz',
      'takeout-20260201T000000Z-1-002.tgz',
    ];
    const { exports } = groupExports(
      names.map((n) => file(n)),
      new Set(),
      new Set(),
    );
    expect(exports).toHaveLength(2);
  });

  it('treats a rejected index candidate as a media part', () => {
    const name = 'takeout-20260101T000000Z-001.tgz';
    const asIndex = groupExports([file(name)], new Set(), new Set());
    expect(asIndex.orphanIndexes).toHaveLength(1);
    const asMedia = groupExports([file(name)], new Set(), new Set([name]));
    expect(asMedia.exports).toHaveLength(1);
    expect(asMedia.orphanIndexes).toHaveLength(0);
  });

  it('assigns a late-arriving earlier part to the same chain', () => {
    const names = ['takeout-20260101T000000Z-1-002.tgz', 'takeout-20260101T000000Z-1-001.tgz'];
    const { exports } = groupExports(
      names.map((n) => file(n)),
      new Set(),
      new Set(),
    );
    expect(exports).toHaveLength(1);
    expect(exports[0].parts.map((p) => p.partNumber)).toEqual([1, 2]);
  });
});
