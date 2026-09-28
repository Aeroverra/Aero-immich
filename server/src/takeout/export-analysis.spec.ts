import { analyzeExport } from 'src/takeout/export-analysis';
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
