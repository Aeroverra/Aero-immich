import { analyzeExport, crossCheckIndex } from 'src/takeout/export-analysis';
import { pathKey } from 'src/takeout/path-key';
import {
  ArchiveBrowserIndex,
  CatalogSummary,
  ExportAnalysisInput,
  ExportAnalysisPart,
  LastReadAnalysis,
} from 'src/takeout/types';
import { describe, expect, it } from 'vitest';

const GiB = 2 ** 30;

function part(partNumber: number, size: number, extra: Partial<ExportAnalysisPart> = {}): ExportAnalysisPart {
  return {
    fileName: `takeout-20260914T211500Z-1-${String(partNumber).padStart(3, '0')}.tgz`,
    segment: 1,
    partNumber,
    timestamp: '20260914T211500Z',
    size,
    kind: 'tgz',
    isIndex: false,
    stable: true,
    isMissing: false,
    catalogStatus: 'none',
    catalogError: null,
    ...extra,
  };
}

const zipPart = (partNumber: number, size: number, extra: Partial<ExportAnalysisPart> = {}) =>
  part(partNumber, size, {
    fileName: `takeout-20260914T211500Z-1-${String(partNumber).padStart(3, '0')}.zip`,
    kind: 'zip',
    ...extra,
  });

function index(files: string[], totalSizeText: string | null = null): ArchiveBrowserIndex {
  return { googleJobId: null, accountEmail: null, createdText: null, totalSizeText, services: [], files };
}

const summary = (over: Partial<CatalogSummary> = {}): CatalogSummary => ({
  assetJsons: 100,
  albumJsons: 0,
  unknownJsons: 0,
  matched: { fastTrack: 0, normal: 0, forgottenDuplicates: 0, edited: 0 },
  jsonWithoutMedia: [],
  mediaWithoutJson: [],
  ...over,
});

const lastRead = (over: Partial<LastReadAnalysis> = {}): LastReadAnalysis => ({
  at: '2026-09-28T00:00:00.000Z',
  runId: 'run-1',
  catalogSummary: summary(),
  indexMissingFiles: null,
  notInIndex: 0,
  unreadableParts: [],
  unreadableEntries: 0,
  ...over,
});

function input(parts: ExportAnalysisPart[], extra: Partial<ExportAnalysisInput> = {}): ExportAnalysisInput {
  return {
    parts,
    index: null,
    indexTotalBytes: null,
    listingPaths: null,
    corruptListings: [],
    lastRead: null,
    ...extra,
  };
}

// Names from the family export: the index lists the full name, the archive holds the name Google shortened
const DIR_2022 = 'Takeout/Google Photos/Photos from 2022';
const SHORTENED = [
  {
    listed:
      'Aeroverra_modern_e-commerce_logo_geared_towards_developers_db305a8a-a454-4d14-9a9c-011fa5fa3ac6.png.supplemental-metadata.json',
    stored: 'Aeroverra_modern_e-commerce_logo_geared_towards_developers_db305a8a-a454-4d14-9a9c-011fa5fa3ac6.png..json',
  },
  {
    listed:
      'Aeroverra_a_lighthouse_on_a_cliff_crepus_2f1b61f9-68bb-4ec6-ada3-afbfba729402.png.supplemental-metadata.json',
    stored: 'Aeroverra_a_lighthouse_on_a_cliff_crepus_2f1b61f9-68bb-4ec6-ada3-afbfba729402.json',
  },
  {
    listed:
      'Aeroverra_whitehat_hacker_with_lots_of_money_f594334f-b725-4807-b34a-991129463ed3.png.supplemental-metadata.json',
    stored: 'Aeroverra_whitehat_hacker_with_lots_of_money_f594334f-b725-4807-b34a-991129463ed3.png.sup.json',
  },
  {
    listed: 'Screenshot 2022-01-27 13_07_11.583191compressed-compressed-crop-2022-01-27 13_06_31.523562.jpeg',
    stored: 'Screenshot 2022-01-27 13_07_11.58319.jpeg',
  },
].map(({ listed, stored }) => ({ listed: `${DIR_2022}/${listed}`, stored: `${DIR_2022}/${stored}` }));

describe('crossCheckIndex', () => {
  it('counts a name Google shortened in the archive as present, and still reports a missing file', () => {
    const media = `${DIR_2022}/Aeroverra_modern_e-commerce_logo_geared_towards_developers_db305a8a-a454-4d14-9a9c-011fa5fa3ac6.png`;
    const missing = `${DIR_2022}/IMG_20220101_101010.jpg`;
    const indexFiles = [media, ...SHORTENED.map((s) => s.listed), missing, `${missing}.supplemental-metadata.json`];
    const archiveKeys = new Set([media, ...SHORTENED.map((s) => s.stored)].map((path) => pathKey(path)));

    expect(crossCheckIndex(indexFiles, archiveKeys)).toEqual({
      missing: [missing, `${missing}.supplemental-metadata.json`],
      notInIndex: 0,
    });
  });

  it('lets one shortened name stand in for one index path of its own directory only', () => {
    const indexFiles = [
      'Takeout/Google Photos/Trip/holiday_by_the_sea_first_day.jpg',
      'Takeout/Google Photos/Trip/holiday_by_the_sea_second_day.jpg',
      'Takeout/Google Photos/Other/holiday_by_the_sea_third_day.jpg',
    ];
    const archiveKeys = new Set(['Takeout/Google Photos/Trip/holiday_by_the_sea.jpg']);

    expect(crossCheckIndex(indexFiles, archiveKeys)).toEqual({ missing: indexFiles.slice(1), notInIndex: 0 });
  });

  it('counts the album extras that the index lists under album folders and the part holds at the root as present', () => {
    // family exports: the index lists the extras under each album folder, the part holds one copy at the root
    const root = 'Takeout/Google Photos';
    const extras = ['shared_album_comments.json', 'user-generated-memory-titles.json', 'remember-list.json'];
    const indexFiles = [
      ...extras.map((name) => `${root}/Thursday in Concord/${name}`),
      `${root}/Trip/shared_album_comments.json`,
      `${root}/Trip/print-subscriptions.json`,
      `${root}/Trip/metadata.json`,
      `${root}/Trip/IMG_0001.jpg`,
    ];
    const archiveKeys = new Set([...extras.map((name) => `${root}/${name}`), `${root}/metadata.json`]);

    expect(crossCheckIndex(indexFiles, archiveKeys)).toEqual({
      // an extras name found nowhere, a name that is not an album extra and a media file are still missing
      missing: [`${root}/Trip/print-subscriptions.json`, `${root}/Trip/metadata.json`, `${root}/Trip/IMG_0001.jpg`],
      notInIndex: 1,
    });
  });

  it('never takes a longer name, another extension or a listed file for a shortened one', () => {
    const indexFiles = ['a/photo_2022.jpg', 'a/clip_2022_long_name.mp4', 'a/clip_2022.mp4'];
    const archiveKeys = new Set(['a/photo_2022_edited.jpg', 'a/clip_2022.mov', 'a/clip_2022.mp4']);

    expect(crossCheckIndex(indexFiles, archiveKeys)).toEqual({
      missing: ['a/photo_2022.jpg', 'a/clip_2022_long_name.mp4'],
      notInIndex: 2,
    });
  });
});

describe('analyzeExport', () => {
  it('reports a clean export without an index and a small last part as complete', () => {
    const a = analyzeExport(input([part(1, 2 * GiB), part(2, 1 * GiB)]));
    expect(a.completeness).toBe('complete');
    expect(a.missingParts).toEqual([]);
    expect(a.sizeCheck).toBe('unknown');
  });

  it('flags a numbering gap as incomplete', () => {
    const a = analyzeExport(input([part(1, 2 * GiB), part(3, 1 * GiB)]));
    expect(a.completeness).toBe('incomplete');
    expect(a.missingParts).toEqual([{ segment: 1, partNumber: 2, expectedName: 'takeout-20260914T211500Z-1-002.tgz' }]);
    expect(a.reasons).toContain('missing_part');
  });

  it('marks a full-size last part without an index as uncertain', () => {
    const a = analyzeExport(input([part(1, 2 * GiB), part(2, 2 * GiB)]));
    expect(a.completeness).toBe('uncertain');
    expect(a.lastPartMayBeMissing).toBe(true);
    expect(a.reasons).toContain('last_part_may_be_missing');
  });

  it('lists a small non-last part informationally', () => {
    const a = analyzeExport(input([part(1, GiB / 2), part(2, 2 * GiB), part(3, 2 * GiB)]));
    expect(a.smallParts).toContain('takeout-20260914T211500Z-1-001.tgz');
  });

  it('detects the 2/4/10/50 GiB split sizes and null beyond 50 GiB', () => {
    expect(analyzeExport(input([part(1, 2 * GiB)])).splitSize).toBe(2 * GiB);
    expect(analyzeExport(input([part(1, 4 * GiB)])).splitSize).toBe(4 * GiB);
    expect(analyzeExport(input([part(1, 10 * GiB)])).splitSize).toBe(10 * GiB);
    expect(analyzeExport(input([part(1, 50 * GiB)])).splitSize).toBe(50 * GiB);
    expect(analyzeExport(input([part(1, 60 * GiB)])).splitSize).toBeNull();
  });

  describe('size check against the index total', () => {
    const parts = [part(1, 50 * GiB), part(2, 50 * GiB)];
    const withIndex = (ratio: number) =>
      analyzeExport(input(parts, { index: index([]), indexTotalBytes: Math.round((100 * GiB) / ratio) }));

    it('0.94 is incomplete (size_shortfall)', () => {
      const a = withIndex(0.94);
      expect(a.sizeCheck).toBe('short');
      expect(a.completeness).toBe('incomplete');
      expect(a.reasons).toContain('size_shortfall');
    });

    it('0.97 is uncertain (low)', () => {
      const a = withIndex(0.97);
      expect(a.sizeCheck).toBe('low');
      expect(a.completeness).toBe('uncertain');
    });

    it('1.0 is complete', () => {
      const a = withIndex(1);
      expect(a.sizeCheck).toBe('ok');
      expect(a.completeness).toBe('complete');
      expect(a.partsTotalBytes).toBe(100 * GiB);
      expect(a.indexTotalBytes).toBe(100 * GiB);
    });
  });

  it('cross-checks the zip listings against the index before any read', () => {
    const files = ['Takeout/Google Photos/a.jpg', 'Takeout/Google Photos/b.jpg'];
    const listingPaths = new Set([pathKey('Takeout/Google Photos/a.jpg'), pathKey('Takeout/Google Photos/extra.jpg')]);
    const a = analyzeExport(input([zipPart(1, GiB)], { index: index(files), indexTotalBytes: GiB, listingPaths }));
    expect(a.completeness).toBe('incomplete');
    expect(a.listingChecked).toBe(true);
    expect(a.indexMissingFiles).toEqual({ count: 1, sample: ['Takeout/Google Photos/b.jpg'] });
    expect(a.notInIndex).toBe(1);
    expect(a.reasons).toContain('index_missing_files');
  });

  it('finds the names Google shortened in the zip listings before any read (family export)', () => {
    const files = SHORTENED.map((s) => s.listed);
    const listingPaths = new Set(SHORTENED.map((s) => pathKey(s.stored)));
    const a = analyzeExport(input([zipPart(1, GiB)], { index: index(files), indexTotalBytes: GiB, listingPaths }));
    expect(a.indexMissingFiles).toEqual({ count: 0, sample: [] });
    expect(a.notInIndex).toBe(0);
    expect(a.completeness).toBe('complete');
  });

  it('finds album extras at the root of the zip listings before any read', () => {
    const files = ['Takeout/Google Photos/Thursday in Concord/shared_album_comments.json'];
    const listingPaths = new Set([pathKey('Takeout/Google Photos/shared_album_comments.json')]);
    const a = analyzeExport(input([zipPart(1, GiB)], { index: index(files), indexTotalBytes: GiB, listingPaths }));
    expect(a.indexMissingFiles).toEqual({ count: 0, sample: [] });
    expect(a.notInIndex).toBe(0);
    expect(a.completeness).toBe('complete');
  });

  it('compares index and listing paths by pathKey (trailing spaces, NFD)', () => {
    const files = ['Takeout/Google Photos/Trip/Café.jpg'];
    const listingPaths = new Set([pathKey('Takeout/Google Photos/Trip /Café.jpg')]);
    const a = analyzeExport(input([zipPart(1, GiB)], { index: index(files), indexTotalBytes: GiB, listingPaths }));
    expect(a.indexMissingFiles.count).toBe(0);
    expect(a.completeness).toBe('complete');
  });

  it('is complete with an index, a size in range and all-tgz parts (no listing possible)', () => {
    const a = analyzeExport(
      input([part(1, 2 * GiB), part(2, 2 * GiB)], { index: index(['x']), indexTotalBytes: 4 * GiB }),
    );
    expect(a.completeness).toBe('complete');
    expect(a.listingChecked).toBe(false);
  });

  it('keeps an all-zip export uncertain until its listings were cross-checked', () => {
    const a = analyzeExport(
      input([zipPart(1, GiB)], { index: index(['x']), indexTotalBytes: GiB, listingPaths: null }),
    );
    expect(a.completeness).toBe('uncertain');
  });

  it('reports a part that is still being copied as uncertain', () => {
    const a = analyzeExport(input([part(1, 2 * GiB), part(2, 1 * GiB, { stable: false })]));
    expect(a.completeness).toBe('uncertain');
    expect(a.reasons).toContain('part_unstable');
  });

  it('marks a corrupt zip listing and a part missing on disk as incomplete', () => {
    const a = analyzeExport(
      input([zipPart(1, GiB), zipPart(2, GiB, { isMissing: true })], {
        corruptListings: [
          { fileName: 'takeout-20260914T211500Z-1-001.zip', error: 'zip end of central directory not found' },
        ],
      }),
    );
    expect(a.corruptParts[0]).toContain('end of central directory');
    expect(a.completeness).toBe('incomplete');
    expect(a.reasons).toEqual(expect.arrayContaining(['corrupt_part', 'part_missing_on_disk']));
  });

  it('uses the post-read checks of the last run: an unreadable part is incomplete', () => {
    const unreadable = { fileName: 'takeout-20260914T211500Z-1-002.tgz', error: 'truncated', offset: 123, size: GiB };
    const a = analyzeExport(
      input([part(1, 2 * GiB), part(2, GiB, { catalogStatus: 'error', catalogError: 'truncated' })], {
        lastRead: lastRead({ unreadableParts: [unreadable], unreadableEntries: 2 }),
      }),
    );
    expect(a.completeness).toBe('incomplete');
    expect(a.unreadableParts).toEqual([unreadable]);
    expect(a.unreadableEntries).toBe(2);
    expect(a.lastReadRunId).toBe('run-1');
    expect(a.reasons).toContain('part_unreadable');
  });

  it('forgets an unreadable part that was replaced since the run', () => {
    const unreadable = { fileName: 'takeout-20260914T211500Z-1-002.tgz', error: 'truncated', offset: 123, size: GiB };
    const a = analyzeExport(
      input([part(1, 2 * GiB), part(2, GiB, { catalogStatus: 'none' })], {
        lastRead: lastRead({ unreadableParts: [unreadable] }),
      }),
    );
    expect(a.unreadableParts).toEqual([]);
    expect(a.completeness).toBe('complete');
  });

  it('takes the index cross-check and the JSON/media cross-check from the last run', () => {
    const a = analyzeExport(
      input([part(1, 2 * GiB)], {
        index: index(['a', 'b']),
        indexTotalBytes: 2 * GiB,
        lastRead: lastRead({
          indexMissingFiles: { count: 1, sample: ['b'] },
          notInIndex: 3,
          catalogSummary: summary({ jsonWithoutMedia: ['x.json'], mediaWithoutJson: ['y.jpg'] }),
        }),
      }),
    );
    expect(a.indexMissingFiles.count).toBe(1);
    expect(a.notInIndex).toBe(3);
    expect(a.jsonWithoutMedia).toEqual({ count: 1, sample: ['x.json'] });
    expect(a.mediaWithoutJson).toEqual({ count: 1, sample: ['y.jpg'] });
    expect(a.completeness).toBe('incomplete');
    expect(a.reasons).toEqual(expect.arrayContaining(['index_missing_files', 'orphan_json']));
  });

  it('never emits not_scanned', () => {
    const a = analyzeExport(input([part(1, 2 * GiB), part(2, GiB)]));
    expect(a.reasons).not.toContain('not_scanned' as never);
  });
});
