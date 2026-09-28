import { analyzeExport } from 'src/takeout/export-analysis';
import { ArchiveBrowserIndex, CatalogSummary, ExportAnalysisInput, ExportAnalysisPart } from 'src/takeout/types';
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
    scanStatus: 'scanned',
    scanError: null,
    ...extra,
  };
}

const emptySummary: CatalogSummary = {
  assetJsons: 100,
  albumJsons: 0,
  unknownJsons: 0,
  matched: { fastTrack: 0, normal: 0, forgottenDuplicates: 0, edited: 0 },
  jsonWithoutMedia: [],
  mediaWithoutJson: [],
};

function input(parts: ExportAnalysisPart[], extra: Partial<ExportAnalysisInput> = {}): ExportAnalysisInput {
  return { parts, index: null, catalogPaths: null, catalogSummary: emptySummary, previous: null, ...extra };
}

describe('analyzeExport', () => {
  it('reports a clean export as complete', () => {
    const a = analyzeExport(input([part(1, 2 * GiB), part(2, 1 * GiB)]));
    expect(a.completeness).toBe('complete');
    expect(a.missingParts).toEqual([]);
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

  it('lists a small non-last part informationally without changing completeness by itself', () => {
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

  it('cross-checks the index and fails on a missing file', () => {
    const index: ArchiveBrowserIndex = {
      googleJobId: null,
      accountEmail: null,
      createdText: null,
      totalSizeText: null,
      services: [],
      files: ['Takeout/Google Photos/a.jpg', 'Takeout/Google Photos/b.jpg'],
    };
    const a = analyzeExport(
      input([part(1, GiB)], { index, catalogPaths: new Set(['Takeout/Google Photos/a.jpg']) }),
    );
    expect(a.completeness).toBe('incomplete');
    expect(a.indexMissingFiles.count).toBe(1);
    expect(a.reasons).toContain('index_missing_files');
  });

  it('is complete when the index cross-check finds nothing missing', () => {
    const index: ArchiveBrowserIndex = {
      googleJobId: null,
      accountEmail: null,
      createdText: null,
      totalSizeText: null,
      services: [],
      files: ['Takeout/Google Photos/a.jpg'],
    };
    const a = analyzeExport(input([part(1, 2 * GiB), part(2, 2 * GiB)], { index, catalogPaths: new Set(['Takeout/Google Photos/a.jpg']) }));
    expect(a.completeness).toBe('complete');
  });

  it('reuses the previous cross-check when the catalog is not recomputed', () => {
    const previous = analyzeExport(
      input([part(1, GiB)], {
        index: { googleJobId: null, accountEmail: null, createdText: null, totalSizeText: null, services: [], files: ['x', 'y'] },
        catalogPaths: new Set(['x']),
      }),
    );
    expect(previous.indexMissingFiles.count).toBe(1);
    const again = analyzeExport(input([part(1, GiB)], { index: previous.catalogSummary ? null : null, previous }));
    expect(again.indexMissingFiles.count).toBe(1);
    expect(again.completeness).toBe('incomplete');
  });

  it('marks corrupt and missing parts', () => {
    const a = analyzeExport(
      input([part(1, GiB, { scanStatus: 'error', scanError: 'gunzip error at 123' }), part(2, GiB, { scanStatus: 'missing' })]),
    );
    expect(a.corruptParts[0]).toContain('gunzip error');
    expect(a.completeness).toBe('incomplete');
    expect(a.reasons).toContain('corrupt_part');
    expect(a.reasons).toContain('part_missing_on_disk');
  });
});
