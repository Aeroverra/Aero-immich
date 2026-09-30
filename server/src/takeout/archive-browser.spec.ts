import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArchiveBrowser, parseSizeText } from 'src/takeout/archive-browser';
import { describe, expect, it } from 'vitest';

const REAL = resolve(process.cwd(), '../../takeout-research/index/archive_browser.html');

describe('parseArchiveBrowser', () => {
  it('parses a synthetic index with two services, a root file, entities and a trailing-space folder', () => {
    const html = [
      '<div class="job-id hidden">JOB123</div>',
      '<h1 class="header_title">Archive for test@example.com</h1>',
      '<div class="header_subtext">Jan 1, 2026, 12:00:00 AM UTC • 1.5 GB • <a href="x">Learn more</a></div>',
      '<div id="service-details-PHOTOS" class="service-detail"><div class="service-header"><h1>Google Photos</h1>3 files exported successfully • 1.2 GB</div>',
      '<div class="file-leaf"><div class="extracted-file-name">root.jpg</div></div>',
      '<div class="extracted-folder-name">Photos from 2020</div>',
      '<div class="file-leaf"><div class="extracted-file-name"> a.jpg</div></div>',
      '<div class="file-leaf"><div class="extracted-file-name">b &amp; c.jpg</div></div>',
      '<div class="extracted-folder-name">Trailing </div>',
      '<div class="file-leaf"><div class="extracted-file-name">d.jpg</div></div></div>',
      '<div id="service-details-DRIVE" class="service-detail"><div class="service-header"><h1>Drive</h1>1 files exported successfully • 300 MB</div>',
      '<div class="extracted-folder-name">Docs</div>',
      '<div class="file-leaf"><div class="extracted-file-name">e.txt</div></div></div>',
    ].join('');

    const index = parseArchiveBrowser(html);
    expect(index.googleJobId).toBe('JOB123');
    expect(index.accountEmail).toBe('test@example.com');
    expect(index.createdText).toBe('Jan 1, 2026, 12:00:00 AM UTC');
    expect(index.totalSizeText).toBe('1.5 GB');
    expect(index.services).toEqual([
      { englishName: 'Google Photos', folderName: 'Google Photos', fileCount: 3, sizeText: '1.2 GB' },
      { englishName: 'Drive', folderName: 'Drive', fileCount: 1, sizeText: '300 MB' },
    ]);
    expect(index.files).toEqual([
      'Takeout/Google Photos/root.jpg',
      'Takeout/Google Photos/Photos from 2020/a.jpg',
      'Takeout/Google Photos/Photos from 2020/b & c.jpg',
      'Takeout/Google Photos/Trailing/d.jpg',
      'Takeout/Drive/Docs/e.txt',
    ]);
  });

  it.runIf(existsSync(REAL))('parses the real archive_browser.html (88340 files)', () => {
    const index = parseArchiveBrowser(readFileSync(REAL, 'utf8'));
    expect(index.accountEmail).toBe('88tontos@gmail.com');
    expect(index.googleJobId).toBe('dd79eba9-4aa8-4d2a-a8bb-66d4e97ff594');
    expect(index.totalSizeText).toBe('730.64 GB');
    expect(index.createdText).toBe('Sep 15, 2026, 12:41:38 AM PDT');
    expect(index.services[0].englishName).toBe('Google Photos');
    expect(index.services[0].fileCount).toBe(88_340);
    expect(index.files).toHaveLength(88_340);
    expect(index.files.every((f) => f.startsWith('Takeout/Google Photos/'))).toBe(true);
  });
});

describe('parseSizeText', () => {
  it('reads the binary units Google prints with decimal names', () => {
    expect(parseSizeText('730.64 GB')).toBe(Math.round(730.64 * 1024 ** 3));
    expect(parseSizeText('730.64 GB')! / 1e9).toBeCloseTo(784.5, 1);
    expect(parseSizeText('12 MB')).toBe(12 * 1024 ** 2);
    expect(parseSizeText('1.2 TB')).toBe(Math.round(1.2 * 1024 ** 4));
    expect(parseSizeText('512 KB')).toBe(512 * 1024);
    expect(parseSizeText('1,024 MB')).toBe(1024 ** 3);
  });

  it('returns null for garbage', () => {
    expect(parseSizeText(null)).toBeNull();
    expect(parseSizeText('')).toBeNull();
    expect(parseSizeText('lots')).toBeNull();
    expect(parseSizeText('12 parsecs')).toBeNull();
    expect(parseSizeText('GB 12')).toBeNull();
  });
});
