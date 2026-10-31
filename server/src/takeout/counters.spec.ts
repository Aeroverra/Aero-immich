import { countersFromRows, emptyCounters } from 'src/takeout/counters';
import { CounterRow } from 'src/takeout/types';
import { describe, expect, it } from 'vitest';

function row(partial: Partial<CounterRow>): CounterRow {
  return {
    action: 'upload',
    status: 'done',
    fileKind: 'image',
    matcher: null,
    fallbacks: [],
    rotationState: null,
    isCover: false,
    groupKind: null,
    reason: null,
    count: 1,
    ...partial,
  };
}

describe('countersFromRows', () => {
  it('derives every counter from grouped rows', () => {
    const rows: CounterRow[] = [
      row({
        action: 'upload',
        status: 'done',
        fileKind: 'image',
        matcher: 'fastTrack',
        count: 3,
        fallbacks: ['tagged', 'albumAdded'],
      }),
      row({ action: 'upload', status: 'planned', fileKind: 'video', matcher: 'normal', count: 2 }),
      row({ action: 'upload', status: 'done', fileKind: 'image', reason: 'server had a smaller version', count: 1 }),
      row({ action: 'serverDuplicate', status: 'done', fileKind: 'image', count: 4 }),
      row({ action: 'betterOnServer', status: 'done', fileKind: 'image', count: 1 }),
      row({ action: 'alreadyProcessed', status: 'done', fileKind: 'image', count: 2 }),
      row({ action: 'localDuplicate', status: 'skipped', fileKind: 'image', count: 5 }),
      row({ action: 'rotateOnlyDropped', status: 'skipped', fileKind: 'image', count: 2 }),
      row({ action: 'filteredPartner', status: 'skipped', fileKind: 'image', count: 1 }),
      row({ action: 'assetJson', status: 'skipped', fileKind: 'json', count: 10 }),
      row({ action: 'albumJson', status: 'skipped', fileKind: 'json', count: 2 }),
      row({ action: 'unknownJson', status: 'skipped', fileKind: 'json', count: 1 }),
      row({ action: 'useless', status: 'skipped', fileKind: 'useless', count: 3 }),
      row({ action: 'banned', status: 'skipped', fileKind: 'banned', count: 1 }),
      row({ action: 'sidecarXmp', status: 'skipped', fileKind: 'sidecar', count: 2 }),
      row({ action: 'missingMetadata', status: 'skipped', fileKind: 'image', count: 1 }),
      row({
        action: 'upload',
        status: 'done',
        fileKind: 'image',
        rotationState: 'applied',
        count: 1,
        fallbacks: ['zoneAssumed', 'stacked', 'albumCreated:Album A', 'metadataSaved'],
      }),
      row({ action: 'upload', status: 'error', fileKind: 'image', count: 1 }),
    ];

    const c = countersFromRows(rows, { total: 100, done: 40 });

    expect(c.scanned.images).toBe(3 + 1 + 4 + 1 + 2 + 5 + 2 + 1 + 1 + 1 + 1);
    expect(c.scanned.videos).toBe(2);
    expect(c.scanned.assetJsons).toBe(10);
    expect(c.scanned.albumJsons).toBe(2);
    expect(c.scanned.unknownJsons).toBe(1);
    expect(c.scanned.useless).toBe(3);
    expect(c.scanned.banned).toBe(1);
    expect(c.scanned.sidecars).toBe(2);
    expect(c.matched.fastTrack).toBe(3);
    expect(c.matched.normal).toBe(2);
    expect(c.matched.missingMetadata).toBe(1);
    expect(c.discarded.localDuplicates).toBe(5);
    expect(c.discarded.rotateOnlyDropped).toBe(2);
    expect(c.discarded.filteredPartner).toBe(1);
    expect(c.result.toUpload).toBe(3 + 2 + 1 + 1 + 1);
    expect(c.result.uploaded).toBe(3 + 1 + 1);
    expect(c.result.largerUploaded).toBe(1);
    expect(c.result.serverDuplicates).toBe(4);
    expect(c.result.betterOnServer).toBe(1);
    expect(c.result.alreadyProcessed).toBe(2);
    expect(c.result.rotationsApplied).toBe(1);
    expect(c.result.zoneAssumed).toBe(1);
    expect(c.result.stacked).toBe(1);
    expect(c.result.albumsCreated).toBe(1);
    expect(c.result.albumAdds).toBe(3);
    expect(c.result.tagged).toBe(3);
    expect(c.result.metadataSaved).toBe(1);
    expect(c.result.errors).toBe(1);
    expect(c.bytes).toEqual({ total: 100, done: 40 });
  });

  it('counts partUnreadable and missingFromArchive rows as discarded, not as files', () => {
    const c = countersFromRows(
      [
        row({ action: 'partUnreadable', status: 'skipped', fileKind: 'other', count: 2 }),
        row({ action: 'missingFromArchive', status: 'skipped', fileKind: 'other', count: 5 }),
      ],
      { total: 0, done: 0 },
    );
    expect(c.discarded.unreadable).toBe(2);
    expect(c.discarded.missingFromArchive).toBe(5);
    expect(c.scanned.files).toBe(0);
  });

  it('emptyCounters is all zero', () => {
    const c = emptyCounters();
    expect(c.result.uploaded).toBe(0);
    expect(c.scanned.files).toBe(0);
  });
});
