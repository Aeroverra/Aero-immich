import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { listZipNames, readArchiveEntry, walkArchive } from 'src/takeout/archive-reader';
import { buildTar, buildTarGz, buildTarGzConcatenated, buildZip, sha1, ZipInput } from 'src/takeout/test-fixtures';
import { ArchiveKind } from 'src/takeout/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'takeout-reader-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Collected {
  path: string;
  size: number;
  seq: number;
  error: string | null;
  sha1: string | null;
}

async function collect(file: string, kind: ArchiveKind, options: Parameters<typeof walkArchive>[3] = {}): Promise<Collected[]> {
  const out: Collected[] = [];
  await walkArchive(
    file,
    kind,
    async (entry, open) => {
      let digest: string | null = null;
      if (!entry.error) {
        const chunks: Buffer[] = await Array.fromAsync((await open()) as AsyncIterable<Buffer>);
        digest = sha1(Buffer.concat(chunks)).toString('hex');
      }
      out.push({ path: entry.path, size: entry.size, seq: entry.seq, error: entry.error, sha1: digest });
    },
    options,
  );
  return out;
}

describe('zip reader', () => {
  const data = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37) % 256));
  const inputs: ZipInput[] = [
    { nameBytes: Buffer.from('stored.bin', 'utf8'), data: data(500), method: 0 },
    { nameBytes: Buffer.from('deflated.txt', 'utf8'), data: Buffer.from('hello '.repeat(200)), method: 8 },
    { nameBytes: Buffer.from('unicode-é.txt', 'utf8'), data: data(64), method: 8, utf8Flag: true },
    { nameBytes: Buffer.from([0x63, 0x61, 0x66, 0x82, 0x2e, 0x62, 0x69, 0x6e]), data: data(10), method: 0 }, // caf(CP437 0x82 = e).bin
    { nameBytes: Buffer.from('big64.bin', 'utf8'), data: data(1000), method: 8, zip64: true },
  ];
  let file: string;

  beforeAll(async () => {
    file = join(dir, 'test.zip');
    await writeFile(file, buildZip(inputs));
  });

  it('reads names, sizes and matching SHA-1 in central-directory order', async () => {
    const entries = await collect(file, 'zip');
    expect(entries.map((e) => e.path)).toEqual(['stored.bin', 'deflated.txt', 'unicode-é.txt', 'café.bin', 'big64.bin']);
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    for (const [i, input] of inputs.entries()) {
      expect(entries[i].size).toBe(input.data.length);
      expect(entries[i].sha1).toBe(sha1(input.data).toString('hex'));
    }
  });

  it('reads a zip64 entry (zip64 extra) and a zip64 EOCD', async () => {
    const eocd64 = join(dir, 'z64eocd.zip');
    await writeFile(eocd64, buildZip(inputs, { zip64Eocd: true }));
    const entries = await collect(eocd64, 'zip');
    expect(entries.map((e) => e.path)).toEqual(['stored.bin', 'deflated.txt', 'unicode-é.txt', 'café.bin', 'big64.bin']);
    expect(entries[4].sha1).toBe(sha1(data(1000)).toString('hex'));
  });

  it('honours only and startSeq and lists names', async () => {
    const onlyEntries = await collect(file, 'zip', { only: new Set(['deflated.txt']) });
    expect(onlyEntries.map((e) => e.path)).toEqual(['deflated.txt']);
    const seqEntries = await collect(file, 'zip', { startSeq: 3 });
    expect(seqEntries.map((e) => e.seq)).toEqual([3, 4]);
    expect(await listZipNames(file)).toEqual(['stored.bin', 'deflated.txt', 'unicode-é.txt', 'café.bin', 'big64.bin']);
  });

  it('reports compressed bytes read', async () => {
    let bytes = 0;
    await walkArchive(file, 'zip', async (_e, open) => {
      for await (const _c of (await open()) as AsyncIterable<Buffer>) {
        void _c;
      }
    }, { onBytes: (n) => (bytes = n) });
    expect(bytes).toBeGreaterThan(0);
  });
});

describe('tgz reader', () => {
  const inputs = [
    { name: 'Takeout/Google Photos/a.jpg', data: Buffer.from('AAAA'.repeat(100)) },
    { name: 'Takeout/Google Photos/' + 'long/'.repeat(50) + 'deep.txt', data: Buffer.from('deep'), gnuLong: true },
    { name: 'Takeout/Google Photos/pax path with spaces.bin', data: Buffer.from('pax-data-here'), pax: true },
    { name: 'Takeout/Google Photos/base256.bin', data: Buffer.from('sized'), base256Size: true },
  ];
  let file: string;

  beforeAll(async () => {
    file = join(dir, 'test.tgz');
    await writeFile(file, buildTarGz(inputs));
  });

  it('reads names, sizes and SHA-1 for pax, GNU long names and base-256 sizes', async () => {
    const entries = await collect(file, 'tgz');
    expect(entries.map((e) => e.path)).toEqual(inputs.map((i) => i.name));
    for (const [i, input] of inputs.entries()) {
      expect(entries[i].size).toBe(input.data.length);
      expect(entries[i].sha1).toBe(sha1(input.data).toString('hex'));
    }
  });

  it('handles concatenated gzip members', async () => {
    const concat = join(dir, 'concat.tgz');
    await writeFile(concat, buildTarGzConcatenated(inputs));
    const entries = await collect(concat, 'tgz');
    expect(entries.map((e) => e.path)).toEqual(inputs.map((i) => i.name));
  });

  it('drains entries that are not opened and honours only', async () => {
    const entries = await collect(file, 'tgz', { only: new Set(['Takeout/Google Photos/a.jpg']) });
    expect(entries.map((e) => e.path)).toEqual(['Takeout/Google Photos/a.jpg']);
  });

  it('fails a truncated archive with a byte offset, keeping entries so far', async () => {
    const full = buildTar(inputs);
    const truncated = gzipSync(full.subarray(0, 512 + 512 + 200));
    const badFile = join(dir, 'trunc.tgz');
    await writeFile(badFile, truncated);
    const seen: string[] = [];
    let error: (Error & { byteOffset?: number }) | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/require-await -- handler must return a promise
      await walkArchive(badFile, 'tgz', async (entry) => {
        seen.push(entry.path);
      });
    } catch (error_) {
      error = error_ as Error & { byteOffset?: number };
    }
    expect(error).not.toBeNull();
    expect(typeof error?.byteOffset).toBe('number');
  });

  it('readArchiveEntry returns the index file bytes', async () => {
    const bytes = await readArchiveEntry(file, 'tgz', 'Takeout/Google Photos/a.jpg', 1 << 20);
    expect(bytes?.toString()).toBe('AAAA'.repeat(100));
    expect(await readArchiveEntry(file, 'tgz', 'missing', 1024)).toBeNull();
  });
});
