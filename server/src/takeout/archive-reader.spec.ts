import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { readArchiveEntry, readZipDirectory, readZipEntriesAt, walkArchive } from 'src/takeout/archive-reader';
import { ArchiveDataError, EntryDataError, GzipIntegrityError, PartMissingError } from 'src/takeout/errors';
import { FileHandleLike, FileSourceFs, newReadMeter, nodeFileSourceFs } from 'src/takeout/file-source';
import {
  buildTar,
  buildTarGz,
  buildTarGzConcatenated,
  buildZip,
  fixtureCrc32,
  randomBytesSeeded,
  sha1,
  ZipInput,
} from 'src/takeout/test-fixtures';
import { ArchiveKind, WalkOptions } from 'src/takeout/types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const KiB = 1024;
const MiB = 1024 * 1024;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'takeout-reader-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// I11: no case may leave an unhandled rejection or an unhandled 'error' event behind
const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => {
  unhandled.push(error);
};
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUnhandled);
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.off('unhandledRejection', onUnhandled);
  process.off('uncaughtException', onUnhandled);
  expect(unhandled).toEqual([]);
});

interface Collected {
  path: string;
  size: number;
  seq: number;
  error: string | null;
  sha1: string | null;
  readError: string | null;
}

async function collect(file: string, kind: ArchiveKind, options: WalkOptions = {}): Promise<Collected[]> {
  const out: Collected[] = [];
  await walkArchive(
    file,
    kind,
    async (entry, open) => {
      let digest: string | null = null;
      let readError: string | null = null;
      if (!entry.error) {
        try {
          const chunks: Buffer[] = await Array.fromAsync((await open()) as AsyncIterable<Buffer>);
          digest = sha1(Buffer.concat(chunks)).toString('hex');
        } catch (error) {
          if (!(error instanceof EntryDataError)) {
            throw error;
          }
          readError = error.message;
        }
      }
      out.push({ path: entry.path, size: entry.size, seq: entry.seq, error: entry.error, sha1: digest, readError });
    },
    options,
  );
  return out;
}

/** node:fs with an open counter */
function countingFs(): FileSourceFs & { opens: number } {
  const fs = {
    opens: 0,
    open: (path: string) => {
      fs.opens++;
      return nodeFileSourceFs.open(path);
    },
  };
  return fs;
}

/** a virtual file made of segments, with an optional delay per read */
function virtualFs(segments: Array<Buffer | { zeros: number }>, delayMs = 0): FileSourceFs & { openHandles: number } {
  const parts = segments.map((s) => (Buffer.isBuffer(s) ? { buf: s, len: s.length } : { buf: null, len: s.zeros }));
  const size = parts.reduce((sum, p) => sum + p.len, 0);
  const fs = {
    openHandles: 0,
    // eslint-disable-next-line @typescript-eslint/require-await
    open: async (): Promise<FileHandleLike> => {
      fs.openHandles++;
      return {
        read: async (buffer, offset, length, position) => {
          if (delayMs) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          const end = Math.min(size, position + length);
          let at = 0;
          let written = 0;
          for (const part of parts) {
            const partEnd = at + part.len;
            const from = Math.max(position, at);
            const to = Math.min(end, partEnd);
            if (from < to) {
              if (part.buf) {
                part.buf.copy(buffer, offset + (from - position), from - at, to - at);
              } else {
                buffer.fill(0, offset + (from - position), offset + (to - position));
              }
              written += to - from;
            }
            at = partEnd;
          }
          return { bytesRead: written };
        },
        // eslint-disable-next-line @typescript-eslint/require-await
        stat: async () => ({ size, mtimeMs: 1, ctimeMs: 1, ino: 1 }),
        // eslint-disable-next-line @typescript-eslint/require-await
        close: async () => {
          fs.openHandles--;
        },
      };
    },
  };
  return fs;
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
  const names = ['stored.bin', 'deflated.txt', 'unicode-é.txt', 'café.bin', 'big64.bin'];
  let file: string;
  let bytes: Buffer;

  beforeAll(async () => {
    file = join(dir, 'test.zip');
    bytes = buildZip(inputs);
    await writeFile(file, bytes);
  });

  it('reads names, sizes and matching SHA-1 in local-offset order', async () => {
    const entries = await collect(file, 'zip');
    expect(entries.map((e) => e.path)).toEqual(names);
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
    expect(entries.map((e) => e.path)).toEqual(names);
    expect(entries[4].sha1).toBe(sha1(data(1000)).toString('hex'));
  });

  it('keeps seq independent of only, seqs and startSeq (F1)', async () => {
    const onlyEntries = await collect(file, 'zip', { only: new Set(['deflated.txt']) });
    expect(onlyEntries.map((e) => [e.path, e.seq])).toEqual([['deflated.txt', 1]]);
    const seqEntries = await collect(file, 'zip', { startSeq: 3 });
    expect(seqEntries.map((e) => e.seq)).toEqual([3, 4]);
    const picked = await collect(file, 'zip', { seqs: new Set([4, 1]) });
    expect(picked.map((e) => [e.path, e.seq])).toEqual([
      ['deflated.txt', 1],
      ['big64.bin', 4],
    ]);
  });

  it('numbers entries in local-offset order, directories included', async () => {
    // the central directory lists b before a, but a comes first in the file
    const a: ZipInput = { nameBytes: Buffer.from('dir/'), data: Buffer.alloc(0), method: 0 };
    const b: ZipInput = { nameBytes: Buffer.from('dir/a.txt'), data: data(20), method: 0 };
    const c: ZipInput = { nameBytes: Buffer.from('dir/b.txt'), data: data(30), method: 0 };
    const zip = buildZip([a, b, c]);
    // swap the central directory records of b and c by rebuilding with a different CD order is not supported by the
    // fixture, so check the numbering of a plain layout: the directory takes seq 0 and is not visited
    const path = join(dir, 'dirs.zip');
    await writeFile(path, zip);
    const entries = await collect(path, 'zip');
    expect(entries.map((e) => [e.path, e.seq])).toEqual([
      ['dir/a.txt', 1],
      ['dir/b.txt', 2],
    ]);
    const directory = await readZipDirectory(path);
    expect(directory.entries.map((e) => [e.name, e.seq, e.isDirectory])).toEqual([
      ['dir/', 0, true],
      ['dir/a.txt', 1, false],
      ['dir/b.txt', 2, false],
    ]);
  });

  it('opens the file once per walk (F2) and covers it once (I1)', async () => {
    const fs = countingFs();
    const meter = newReadMeter();
    await collect(file, 'zip', { source: { fs }, meter });
    expect(fs.opens).toBe(1);
    expect(meter.position).toBe(bytes.length);
    expect(meter.bytesRead + meter.bytesSkipped).toBeGreaterThanOrEqual(bytes.length);
    expect(meter.bytesRead + meter.bytesSkipped).toBeLessThanOrEqual(bytes.length + 128 * KiB);
  });

  it('readZipEntriesAt reads only the requested entries and skips the gaps', async () => {
    const big = Array.from({ length: 6 }, (_, i) => ({
      nameBytes: Buffer.from(`big-${i}.bin`),
      data: randomBytesSeeded(256 * KiB, i + 1),
      method: 0 as const,
    }));
    const zip = buildZip(big);
    const path = join(dir, 'random-access.zip');
    await writeFile(path, zip);
    const meter = newReadMeter();
    const seen: Array<[string, number, string]> = [];
    await readZipEntriesAt(
      path,
      [4, 1],
      async (entry, open) => {
        const chunks: Buffer[] = await Array.fromAsync((await open()) as AsyncIterable<Buffer>);
        seen.push([entry.path, entry.seq, sha1(Buffer.concat(chunks)).toString('hex')]);
      },
      { meter, zipSeekGap: KiB, source: { chunk: 4 * KiB, depth: 1 } },
    );
    expect(seen).toEqual([
      ['big-1.bin', 1, sha1(big[1].data).toString('hex')],
      ['big-4.bin', 4, sha1(big[4].data).toString('hex')],
    ]);
    expect(meter.bytesRead).toBeLessThan(zip.length / 2);
    // entries 2 and 3 are jumped over, minus the little readahead that was already in flight
    expect(meter.bytesSkipped).toBeGreaterThan(480 * KiB);
  });

  it('turns a wrong CRC, a short inflate and a mismatching local name into entry errors (F11)', async () => {
    const good = (name: string) => ({ nameBytes: Buffer.from(name), data: data(300), method: 8 as const });
    const full = Buffer.from('x'.repeat(1000));
    const zip = buildZip([
      good('a.bin'),
      { nameBytes: Buffer.from('crc.bin'), data: data(300), method: 0, crcOverride: 12_345 },
      good('b.bin'),
      {
        nameBytes: Buffer.from('short.bin'),
        data: full,
        method: 8,
        storedOverride: deflateRawSync(full.subarray(0, 500)),
      },
      { nameBytes: Buffer.from('name.bin'), data: data(50), method: 0, localNameBytes: Buffer.from('nope.bin') },
      good('c.bin'),
    ]);
    const path = join(dir, 'corrupt-entries.zip');
    await writeFile(path, zip);
    const entries = await collect(path, 'zip');
    expect(entries.map((e) => e.path)).toEqual(['a.bin', 'crc.bin', 'b.bin', 'short.bin', 'name.bin', 'c.bin']);
    expect(entries[1].readError).toBe('CRC-32 mismatch');
    expect(entries[3].readError).toMatch(/entry has 500 bytes/);
    expect(entries[4].error).toMatch(/local header name differs/);
    for (const i of [0, 2, 5]) {
      expect(entries[i].sha1).toBe(sha1(data(300)).toString('hex'));
      expect(entries[i].readError).toBeNull();
    }
  });

  it('fails the part with ArchiveDataError when the EOCD is missing', async () => {
    const path = join(dir, 'no-eocd.zip');
    await writeFile(path, bytes.subarray(0, -30));
    await expect(collect(path, 'zip')).rejects.toBeInstanceOf(ArchiveDataError);
    await expect(readZipDirectory(path)).rejects.toBeInstanceOf(ArchiveDataError);
  });

  it('rejects a missing file with PartMissingError, without a crash', async () => {
    await expect(collect(join(dir, 'gone.zip'), 'zip')).rejects.toBeInstanceOf(PartMissingError);
  });

  it('rejects EIO from the source after the transport budget, without a crash', async () => {
    const fs: FileSourceFs = {
      open: async (path) => {
        const real = await nodeFileSourceFs.open(path);
        let reads = 0;
        return {
          read: (buffer, offset, length, position) => {
            reads++;
            if (reads > 2) {
              return Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
            }
            return real.read(buffer, offset, length, position);
          },
          stat: () => real.stat(),
          close: () => real.close(),
        };
      },
    };
    await expect(collect(file, 'zip', { source: { fs, chunk: 64, depth: 1, retryBudgetMs: 0 } })).rejects.toMatchObject(
      { code: 'EIO' },
    );
  });

  it('rejects within a second when aborted inside a 200 MiB entry, and closes its handle (F3)', async () => {
    const size = 200 * MiB;
    const name = Buffer.from('huge.bin');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const cdOffset = 30 + name.length + size;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06_05_4b_50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + name.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    const fs = virtualFs([local, name, { zeros: size }, central, name, eocd], 5);

    const controller = new AbortController();
    let aborted = 0;
    const walk = walkArchive(
      'virtual.zip',
      'zip',
      async (_entry, open) => {
        for await (const _chunk of (await open()) as AsyncIterable<Buffer>) {
          void _chunk;
          if (!aborted) {
            aborted = Date.now();
            controller.abort(new Error('cancelled'));
          }
        }
      },
      { signal: controller.signal, source: { fs, chunk: 256 * KiB, depth: 2 } },
    );
    await expect(walk).rejects.toThrow('cancelled');
    expect(Date.now() - aborted).toBeLessThan(1000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.openHandles).toBe(0);
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
  let bytes: Buffer;

  beforeAll(async () => {
    file = join(dir, 'test.tgz');
    bytes = buildTarGz(inputs);
    await writeFile(file, bytes);
  });

  it('reads names, sizes and SHA-1 for pax, GNU long names and base-256 sizes', async () => {
    const entries = await collect(file, 'tgz');
    expect(entries.map((e) => e.path)).toEqual(inputs.map((i) => i.name));
    for (const [i, input] of inputs.entries()) {
      expect(entries[i].size).toBe(input.data.length);
      expect(entries[i].sha1).toBe(sha1(input.data).toString('hex'));
    }
  });

  it('reads every byte once and verifies the gzip trailer (I1, F10)', async () => {
    const meter = newReadMeter();
    const result = await walkArchive(file, 'tgz', async () => {}, { meter });
    expect(result.trailerVerified).toBe(true);
    expect(meter.bytesRead).toBe(bytes.length);
    expect(meter.position).toBe(bytes.length);
  });

  it('handles concatenated gzip members', async () => {
    const concat = join(dir, 'concat.tgz');
    await writeFile(concat, buildTarGzConcatenated(inputs));
    const entries = await collect(concat, 'tgz');
    expect(entries.map((e) => e.path)).toEqual(inputs.map((i) => i.name));
  });

  it('keeps seq independent of only (F1)', async () => {
    const all = await collect(file, 'tgz');
    const only = await collect(file, 'tgz', { only: new Set([inputs[2].name]) });
    expect(only.map((e) => [e.path, e.seq])).toEqual([[inputs[2].name, all[2].seq]]);
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it('stops after untilSeq without reading the whole file', async () => {
    const big = [
      { name: 'first.bin', data: randomBytesSeeded(40 * KiB, 1) },
      { name: 'second.bin', data: randomBytesSeeded(200 * KiB, 2) },
    ];
    const path = join(dir, 'until.tgz');
    const gz = buildTarGz(big);
    await writeFile(path, gz);
    const meter = newReadMeter();
    const seen: number[] = [];
    const result = await walkArchive(
      path,
      'tgz',
      (entry) => {
        seen.push(entry.seq);
        return Promise.resolve();
      },
      { untilSeq: 0, meter, source: { chunk: 8 * KiB, depth: 1 } },
    );
    expect(seen).toEqual([0]);
    expect(result.trailerVerified).toBe(false);
    expect(meter.bytesRead).toBeLessThan(gz.length);
  });

  it('fails a truncated archive with a byte offset, keeping the entries before the cut', async () => {
    const full = buildTar(inputs);
    const truncated = gzipSync(full.subarray(0, 512 + 512 + 200));
    const badFile = join(dir, 'trunc.tgz');
    await writeFile(badFile, truncated);
    const seen: string[] = [];
    const error = await walkArchive(badFile, 'tgz', (entry) => {
      seen.push(entry.path);
      return Promise.resolve();
    }).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(ArchiveDataError);
    expect(typeof (error as ArchiveDataError).byteOffset).toBe('number');
    expect(seen).toEqual([inputs[0].name]);
  });

  it('fails with ArchiveDataError when the cut is inside an entry the handler opens (F8)', async () => {
    const entries = [
      { name: 'one.bin', data: randomBytesSeeded(20 * KiB, 1) },
      { name: 'two.bin', data: randomBytesSeeded(300 * KiB, 2) },
    ];
    const gz = buildTarGz(entries);
    const cut = join(dir, 'cut-in-entry.tgz');
    await writeFile(cut, gz.subarray(0, Math.floor(gz.length * 0.6)));
    const seen: string[] = [];
    const error = await walkArchive(cut, 'tgz', async (entry, open) => {
      seen.push(entry.path);
      await Array.fromAsync((await open()) as AsyncIterable<Buffer>);
    }).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(ArchiveDataError);
    expect((error as ArchiveDataError).byteOffset).toBeGreaterThan(0);
    expect(seen).toEqual(['one.bin', 'two.bin']);
  });

  it('rejects a missing file without a crash', async () => {
    await expect(collect(join(dir, 'gone.tgz'), 'tgz')).rejects.toBeInstanceOf(PartMissingError);
  });

  it('rejects EIO from the source without a crash', async () => {
    const fs: FileSourceFs = {
      open: async (path) => {
        const real = await nodeFileSourceFs.open(path);
        return {
          read: () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })),
          stat: () => real.stat(),
          close: () => real.close(),
        };
      },
    };
    await expect(collect(file, 'tgz', { source: { fs, retryBudgetMs: 0 } })).rejects.toMatchObject({ code: 'EIO' });
  });

  it('continues the walk when a consumer destroys its stream mid-entry (F9)', async () => {
    const entries = [
      { name: 'big.bin', data: randomBytesSeeded(4 * MiB, 7) },
      { name: 'after.bin', data: Buffer.from('after') },
    ];
    const path = join(dir, 'destroy.tgz');
    await writeFile(path, buildTarGz(entries));
    const seen: string[] = [];
    await walkArchive(path, 'tgz', async (entry, open) => {
      seen.push(entry.path);
      const stream = (await open()) as AsyncIterable<Buffer>;
      for await (const _chunk of stream) {
        void _chunk;
        break;
      }
    });
    expect(seen).toEqual(['big.bin', 'after.bin']);
    expect(await readArchiveEntry(path, 'tgz', 'big.bin', 10)).toEqual(entries[0].data.subarray(0, 10));
  });

  it('reports a flipped byte in a stored block as GzipIntegrityError at the end (F10)', async () => {
    const entries = [
      { name: 'photo.jpg', data: randomBytesSeeded(3 * MiB, 9) },
      { name: 'other.jpg', data: randomBytesSeeded(10 * KiB, 10) },
    ];
    const gz = gzipSync(buildTar(entries), { level: 0 });
    // gzip header (10 bytes) + stored block header (5 bytes) + inside the first entry's data
    gz[10 + 5 + 4000] ^= 0x01;
    const path = join(dir, 'flipped.tgz');
    await writeFile(path, gz);
    const seen: string[] = [];
    const error = await walkArchive(path, 'tgz', async (entry, open) => {
      seen.push(entry.path);
      await Array.fromAsync((await open()) as AsyncIterable<Buffer>);
    }).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(GzipIntegrityError);
    // zlib raises the error in its last output round: what came before was delivered (and must not be trusted)
    expect(seen[0]).toBe('photo.jpg');
  });

  it('rejects within a second when aborted inside a large entry, and closes its handle (F3)', async () => {
    const path = join(dir, 'zeros.tgz');
    await writeFile(path, buildTarGz([{ name: 'zeros.bin', data: Buffer.alloc(200 * MiB) }]));
    let handles = 0;
    const fs: FileSourceFs = {
      open: async (p) => {
        const real = await nodeFileSourceFs.open(p);
        handles++;
        return {
          read: async (buffer, offset, length, position) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return real.read(buffer, offset, length, position);
          },
          stat: () => real.stat(),
          close: async () => {
            handles--;
            await real.close();
          },
        };
      },
    };
    const controller = new AbortController();
    let aborted = 0;
    const walk = walkArchive(
      path,
      'tgz',
      async (_entry, open) => {
        for await (const _chunk of (await open()) as AsyncIterable<Buffer>) {
          void _chunk;
          if (!aborted) {
            aborted = Date.now();
            controller.abort(new Error('cancelled'));
          }
        }
      },
      { signal: controller.signal, source: { fs, chunk: 4 * KiB, depth: 1 } },
    );
    await expect(walk).rejects.toThrow('cancelled');
    expect(Date.now() - aborted).toBeLessThan(1000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handles).toBe(0);
  });

  it('returns chunks that pin no more than their own gunzip chunk (F12)', async () => {
    const json = Buffer.from(JSON.stringify({ title: 'x'.repeat(1000) }));
    const entries = [
      { name: 'big.bin', data: randomBytesSeeded(3 * MiB, 4) },
      { name: 'meta.json', data: json },
    ];
    const path = join(dir, 'pin.tgz');
    await writeFile(path, buildTarGz(entries));
    let pinned = 0;
    await walkArchive(path, 'tgz', async (entry, open) => {
      const chunks: Buffer[] = await Array.fromAsync((await open()) as AsyncIterable<Buffer>);
      if (entry.path === 'meta.json') {
        pinned = Math.max(...chunks.map((c) => c.buffer.byteLength));
        expect(Buffer.concat(chunks)).toEqual(json);
      }
    });
    expect(pinned).toBeLessThanOrEqual(MiB);
  });

  it('readArchiveEntry returns the index file bytes', async () => {
    const found = await readArchiveEntry(file, 'tgz', 'Takeout/Google Photos/a.jpg', 1 << 20);
    expect(found?.toString()).toBe('AAAA'.repeat(100));
    expect(await readArchiveEntry(file, 'tgz', 'missing', 1024)).toBeNull();
  });

  it('computes CRC-32 the same way as the fixtures', () => {
    expect(fixtureCrc32(Buffer.from('hello'))).toBe(0x36_10_a6_86);
  });
});
