import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core';
import { JobStatus, TakeoutRunStatus } from 'src/enum';
import { TakeoutAnalyzeService } from 'src/services/takeout-analyze.service';
import { buildTarGz, buildZip } from 'src/takeout/test-fixtures';
import { TakeoutMemoryRepository } from 'test/fixtures/takeout-memory.repository';
import { newTestService, ServiceMocks } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const userId = 'user-1';
const HOUR = 3_600_000;

const indexHtml = (files: string[], total: string) =>
  [
    '<h1 class="header_title">Archive for me@example.com</h1>',
    `<div class="header_subtext">Sep 15, 2026 • ${total} • x</div>`,
    '<div id="service-details-PHOTOS" class="service-detail"><h1>Google Photos</h1>',
    ...files.map((f) => `<div class="file-leaf"><div class="extracted-file-name">${f}</div></div>`),
    '</div>',
  ].join('');

describe(TakeoutAnalyzeService.name, () => {
  let sut: TakeoutAnalyzeService;
  let mocks: ServiceMocks;
  let repo: TakeoutMemoryRepository;
  let dir: string;
  let folder: string;
  let exportId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'takeout-analyze-'));
    repo = new TakeoutMemoryRepository();
    ({ sut, mocks } = newTestService(TakeoutAnalyzeService, { takeout: repo as any }));
    StorageCore.setMediaLocation(dir);
    repo.addFolder(userId, 'me');
    folder = join(dir, 'takeouts', 'me');
    await mkdir(folder, { recursive: true });
    exportId = repo.addExport({ userId, completeness: 'unknown' }).id;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function addFile(fileName: string, bytes: Buffer, over: Record<string, unknown> = {}) {
    const path = join(folder, fileName);
    await writeFile(path, bytes);
    const old = new Date(Date.now() - HOUR);
    await utimes(path, old, old);
    const st = await stat(path);
    return repo.addPart({
      exportId,
      userId,
      fileName,
      size: st.size,
      mtime: st.mtime,
      ctime: new Date(Date.now() - HOUR),
      prevSyncSize: st.size,
      ...over,
    });
  }

  it('drains legacy scan jobs', () => {
    expect(sut.handleScanPart()).toBe(JobStatus.Skipped);
    expect(sut.handleScanPart()).toBe(JobStatus.Skipped);
  });

  it('cross-checks the zip listings with the index before any read and reads no media data', async () => {
    const files = ['a.jpg', 'b.jpg'];
    const index = buildTarGz([{ name: 'Takeout/archive_browser.html', data: Buffer.from(indexHtml(files, '1 KB')) }]);
    await addFile('takeout-20260914T211500Z-1-001.tgz', index, { isIndex: true, partNumber: 1, segment: 1 });
    repo.exports[0].indexFileName = 'takeout-20260914T211500Z-1-001.tgz';
    await addFile(
      'takeout-20260914T211500Z-1-001.zip',
      buildZip([{ nameBytes: Buffer.from('Takeout/Google Photos/a.jpg'), data: Buffer.alloc(1024, 1), method: 0 }]),
      { partNumber: 1, segment: 1 },
    );

    expect(await sut.handleAnalyze({ exportId })).toBe(JobStatus.Success);
    const exp = repo.exports[0];
    expect(exp.completeness).toBe('incomplete');
    expect(exp.analysis.listingChecked).toBe(true);
    expect(exp.analysis.indexMissingFiles).toEqual({ count: 1, sample: ['Takeout/Google Photos/b.jpg'] });
    expect(exp.analysis.indexFiles).toEqual(files.map((f) => `Takeout/Google Photos/${f}`));
    expect(exp.analysis.indexTotalBytes).toBe(1024);
    expect(exp.accountEmail).toBe('me@example.com');
    expect(repo.parts.every((p) => Number(p.bytesRead) === 0)).toBe(true);
    expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_takeout_export', userId, expect.anything());
  });

  it('reports a zip part without a central directory as corrupt', async () => {
    await addFile('takeout-20260914T211500Z-1-001.zip', Buffer.from('not a zip at all, still being copied'));
    expect(await sut.handleAnalyze({ exportId })).toBe(JobStatus.Success);
    expect(repo.exports[0].completeness).toBe('incomplete');
    expect(repo.exports[0].analysis.reasons).toContain('corrupt_part');
  });

  it('skips an export with an active run (the run queues the analysis at its end)', async () => {
    repo.addRun({ userId, exportId, status: TakeoutRunStatus.Reading });
    expect(await sut.handleAnalyze({ exportId })).toBe(JobStatus.Skipped);
  });

  it('keeps the post-read checks of the last run', async () => {
    await addFile('takeout-20260914T211500Z-1-001.tgz', buildTarGz([{ name: 'a', data: Buffer.from('x') }]));
    repo.exports[0].analysis = {
      lastRead: {
        at: '2026-09-28T00:00:00.000Z',
        runId: 'r1',
        catalogSummary: null,
        indexMissingFiles: null,
        notInIndex: 0,
        unreadableParts: [],
        unreadableEntries: 3,
      },
    };
    expect(await sut.handleAnalyze({ exportId })).toBe(JobStatus.Success);
    expect(repo.exports[0].analysis.lastReadRunId).toBe('r1');
    expect(repo.exports[0].analysis.unreadableEntries).toBe(3);
    expect(repo.exports[0].analysis.lastRead.runId).toBe('r1');
  });
});
