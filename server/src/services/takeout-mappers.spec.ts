import {
  TakeoutCatalogStatus,
  TakeoutExportReadStatus,
  TakeoutPartReadStatus,
  TakeoutRunStatus,
  TakeoutScanStatus,
  TakeoutSizeCheck,
} from 'src/enum';
import { exportReadStatus, mapAnalysis, mapPart, mapReadStats, mapRun } from 'src/services/takeout-mappers';
import { describe, expect, it } from 'vitest';

const part = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  fileName: 'takeout-20260914T211500Z-1-001.tgz',
  segment: 1,
  partNumber: 1,
  kind: 'tgz',
  isIndex: false,
  size: 100,
  mtime: new Date('2026-09-14T00:00:00Z'),
  isMissing: false,
  catalogStatus: TakeoutCatalogStatus.None,
  catalogVersion: null,
  catalogError: null,
  catalogErrorOffset: null,
  lastReadRunId: null,
  bytesRead: 0,
  entryCount: null,
  ...over,
});

describe('takeout DTO mappers', () => {
  it('derives the read status of a part and the deprecated scan fields', () => {
    expect(mapPart(part())).toMatchObject({
      readStatus: TakeoutPartReadStatus.NotRead,
      scanStatus: TakeoutScanStatus.Pending,
    });
    expect(
      mapPart(part({ catalogStatus: TakeoutCatalogStatus.Complete, catalogVersion: 2, entryCount: 5, bytesRead: 90 })),
    ).toMatchObject({
      readStatus: TakeoutPartReadStatus.Read,
      scanStatus: TakeoutScanStatus.Scanned,
      entryCount: 5,
      bytesRead: 90,
      bytesScanned: 90,
    });
    expect(
      mapPart(
        part({
          catalogStatus: TakeoutCatalogStatus.Error,
          catalogVersion: 2,
          catalogError: 'truncated',
          catalogErrorOffset: '4096',
        }),
      ),
    ).toMatchObject({
      readStatus: TakeoutPartReadStatus.Error,
      readError: 'truncated',
      readErrorOffset: 4096,
      scanError: 'truncated',
      scanStatus: TakeoutScanStatus.Error,
    });
    expect(mapPart(part({ isMissing: true })).readStatus).toBe(TakeoutPartReadStatus.Missing);
    expect(mapPart(part({ catalogStatus: TakeoutCatalogStatus.Partial, catalogVersion: 2 })).readStatus).toBe(
      TakeoutPartReadStatus.Partial,
    );
  });

  it('derives the read status of an export from its present media parts', () => {
    const read = { catalogStatus: TakeoutCatalogStatus.Complete, catalogVersion: 2 };
    expect(exportReadStatus([part(), part()])).toEqual({ readStatus: TakeoutExportReadStatus.NotRead, partsRead: 0 });
    expect(exportReadStatus([part(read), part()])).toEqual({
      readStatus: TakeoutExportReadStatus.Partial,
      partsRead: 1,
    });
    expect(exportReadStatus([part(read), part(read), part({ isIndex: true })])).toEqual({
      readStatus: TakeoutExportReadStatus.Read,
      partsRead: 2,
    });
    expect(
      exportReadStatus([part(read), part({ catalogStatus: TakeoutCatalogStatus.Error, catalogVersion: 2 })]).readStatus,
    ).toBe(TakeoutExportReadStatus.Error);
  });

  it('maps the {} readStats of runs created before the upgrade to zeros', () => {
    const stats = mapReadStats({});
    expect(stats.parts).toEqual([]);
    expect(stats.stagedFiles).toBe(0);
    expect(stats.etaSeconds).toBeNull();
    expect(stats.stagingExpiresAt).toBeNull();
    const run = mapRun({
      id: 'r1',
      exportId: 'e1',
      status: TakeoutRunStatus.Completed,
      importAnyway: false,
      settings: {},
      counters: {},
      readStats: {},
      createdAt: new Date(),
    });
    expect(run.hasStaging).toBe(false);
    expect(run.supersededBy).toBeNull();
    expect(run.counters.discarded.unreadable).toBe(0);
    expect(run.counters.discarded.missingFromArchive).toBe(0);
  });

  it('shows the pause of a paused run only, and never as statistics', () => {
    const base = {
      id: 'r1',
      exportId: 'e1',
      importAnyway: false,
      settings: {},
      counters: {},
      createdAt: new Date(),
    };
    const readStats = {
      pausedAt: '2026-09-29T10:00:00.000Z',
      pausedFrom: TakeoutRunStatus.Fetching,
      pausedMs: 1500.4,
      parts: { a: { partId: 'a', fileName: 'a', size: 1, status: 'paused', pausedMs: 20 } },
    };
    const paused = mapRun({ ...base, status: TakeoutRunStatus.Paused, readStats });
    expect(paused).toMatchObject({ pausedAt: '2026-09-29T10:00:00.000Z', pausedFrom: TakeoutRunStatus.Fetching });
    expect(paused.readStats.pausedMs).toBe(1500);
    expect(paused.readStats.parts[0]).toMatchObject({ status: 'paused', pausedMs: 20 });
    expect(Object.keys(paused.readStats)).not.toContain('pausedAt');
    // a pause the run left (a resume raced a progress write) is not shown
    expect(mapRun({ ...base, status: TakeoutRunStatus.Fetching, readStats })).toMatchObject({
      pausedAt: null,
      pausedFrom: null,
    });
    expect(
      mapRun({ ...base, status: TakeoutRunStatus.Paused, readStats: { pausedAt: 'x', pausedFrom: 'nope' } }),
    ).toMatchObject({ pausedAt: null, pausedFrom: null });
  });

  it('orders the part statistics by segment and part number', () => {
    const stats = mapReadStats({
      parts: {
        b: { partId: 'b', fileName: 'b', size: 1, segment: 1, partNumber: 2 },
        a: { partId: 'a', fileName: 'a', size: 1, segment: 1, partNumber: 1 },
      },
    });
    expect(stats.parts.map((p) => p.partId)).toEqual(['a', 'b']);
    expect(stats.parts[0].status).toBe('pending');
  });

  it('defaults every new analysis field and drops reasons that no longer exist', () => {
    const analysis = mapAnalysis({ reasons: ['not_scanned', 'missing_part'], completeness: 'uncertain' });
    expect(analysis.reasons).toEqual(['missing_part']);
    expect(analysis.sizeCheck).toBe(TakeoutSizeCheck.Unknown);
    expect(analysis.unreadableParts).toEqual([]);
    expect(analysis.indexTotalBytes).toBeNull();
    expect(analysis.listingChecked).toBe(false);
    expect(analysis.lastReadAt).toBeNull();
  });
});
