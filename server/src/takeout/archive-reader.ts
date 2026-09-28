import { createReadStream } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { PassThrough, Readable, Transform, Writable } from 'node:stream';
import { once } from 'node:events';
import { createGunzip, createInflateRaw } from 'node:zlib';
import { ArchiveKind, ArchiveEntryInfo, EntryHandler, WalkOptions } from 'src/takeout/types';

const EOCD_SIG = 0x06_05_4b_50;
const EOCD64_LOCATOR_SIG = 0x07_06_4b_50;
const EOCD64_SIG = 0x06_06_4b_50;
const CD_SIG = 0x02_01_4b_50;
const LOCAL_SIG = 0x04_03_4b_50;
const MAX_EOCD = 65_557;

// CP437 high range (0x80..0xFF) for zip names without a UTF-8 flag or Unicode Path extra.
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
  '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩' +
  '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeCp437(bytes: Buffer): string {
  let out = '';
  for (const byte of bytes) {
    out += byte < 0x80 ? String.fromCodePoint(byte) : CP437_HIGH[byte - 0x80];
  }
  return out;
}

function isValidUtf8(bytes: Buffer): boolean {
  return Buffer.compare(Buffer.from(bytes.toString('utf8'), 'utf8'), bytes) === 0;
}

function dosDateTime(time: number, date: number): Date | null {
  if (date === 0) {
    return null;
  }
  const year = ((date >> 9) & 0x7f) + 1980;
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  const hour = (time >> 11) & 0x1f;
  const minute = (time >> 5) & 0x3f;
  const second = (time & 0x1f) * 2;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  mtime: Date | null;
  seq: number;
  error: string | null;
}

function readExtra(extra: Buffer): Map<number, Buffer> {
  const fields = new Map<number, Buffer>();
  let i = 0;
  while (i + 4 <= extra.length) {
    const id = extra.readUInt16LE(i);
    const size = extra.readUInt16LE(i + 2);
    if (i + 4 + size > extra.length) {
      break;
    }
    fields.set(id, extra.subarray(i + 4, i + 4 + size));
    i += 4 + size;
  }
  return fields;
}

async function readCentralDirectory(filePath: string): Promise<{ entries: ZipEntry[] }> {
  const fh = await openFile(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(MAX_EOCD, size);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) {
      throw new Error('zip EOCD not found');
    }

    let cdEntries = tail.readUInt16LE(eocd + 10);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    let cdSize = tail.readUInt32LE(eocd + 12);

    if (cdEntries === 0xff_ff || cdOffset === 0xff_ff_ff_ff || cdSize === 0xff_ff_ff_ff) {
      const locator = eocd - 20;
      if (locator >= 0 && tail.readUInt32LE(locator) === EOCD64_LOCATOR_SIG) {
        const z64Offset = Number(tail.readBigUInt64LE(locator + 8));
        const head = Buffer.alloc(56);
        await fh.read(head, 0, 56, z64Offset);
        if (head.readUInt32LE(0) === EOCD64_SIG) {
          cdEntries = Number(head.readBigUInt64LE(32));
          cdSize = Number(head.readBigUInt64LE(40));
          cdOffset = Number(head.readBigUInt64LE(48));
        }
      }
    }

    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    const entries: ZipEntry[] = [];
    let p = 0;
    let seq = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === CD_SIG) {
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const modTime = cd.readUInt16LE(p + 12);
      const modDate = cd.readUInt16LE(p + 14);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      const fields = readExtra(extra);

      const z64 = fields.get(0x00_01);
      if (z64) {
        let o = 0;
        if (uncompressedSize === 0xff_ff_ff_ff) {
          uncompressedSize = Number(z64.readBigUInt64LE(o));
          o += 8;
        }
        if (compressedSize === 0xff_ff_ff_ff) {
          compressedSize = Number(z64.readBigUInt64LE(o));
          o += 8;
        }
        if (localOffset === 0xff_ff_ff_ff) {
          localOffset = Number(z64.readBigUInt64LE(o));
          o += 8;
        }
      }

      let name: string;
      const unicodePath = fields.get(0x70_75);
      if (flags & 0x08_00) {
        name = nameBytes.toString('utf8');
      } else if (unicodePath && unicodePath.length > 5) {
        name = unicodePath.subarray(5).toString('utf8');
      } else if (isValidUtf8(nameBytes)) {
        name = nameBytes.toString('utf8');
      } else {
        name = decodeCp437(nameBytes);
      }

      let error: string | null = null;
      if (flags & 0x00_01) {
        error = 'encrypted entry';
      } else if (method !== 0 && method !== 8) {
        error = `unsupported compression method ${method}`;
      }

      entries.push({
        name,
        method,
        flags,
        compressedSize,
        uncompressedSize,
        localOffset,
        mtime: dosDateTime(modTime, modDate),
        seq: seq++,
        error,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries };
  } finally {
    await fh.close();
  }
}

async function dataStartOffset(filePath: string, entry: ZipEntry): Promise<number> {
  const fh = await openFile(filePath, 'r');
  try {
    const head = Buffer.alloc(30);
    await fh.read(head, 0, 30, entry.localOffset);
    if (head.readUInt32LE(0) !== LOCAL_SIG) {
      throw new Error('bad local header signature');
    }
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    return entry.localOffset + 30 + nameLen + extraLen;
  } finally {
    await fh.close();
  }
}

function openZipEntry(filePath: string, entry: ZipEntry, dataStart: number, onBytes?: (n: number) => void, counter?: { read: number }): NodeJS.ReadableStream {
  if (entry.compressedSize === 0) {
    return Readable.from([]);
  }
  const raw = createReadStream(filePath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
  const counting = new Transform({
    transform(chunk: Buffer, _e, cb) {
      if (counter && onBytes) {
        counter.read += chunk.length;
        onBytes(counter.read);
      }
      cb(null, chunk);
    },
  });
  const source = raw.pipe(counting);
  return entry.method === 8 ? source.pipe(createInflateRaw()) : source;
}

async function walkZip(filePath: string, handler: EntryHandler, options: WalkOptions): Promise<{ entries: number }> {
  const { entries } = await readCentralDirectory(filePath);
  const counter = { read: 0 };
  let visited = 0;
  for (const entry of entries) {
    if (options.signal?.aborted) {
      throw new Error('aborted');
    }
    if (options.startSeq !== undefined && entry.seq < options.startSeq) {
      continue;
    }
    if (entry.name.endsWith('/')) {
      continue;
    }
    if (options.only && !options.only.has(entry.name)) {
      continue;
    }
    visited++;
    const info: ArchiveEntryInfo = { path: entry.name, size: entry.uncompressedSize, mtime: entry.mtime, seq: entry.seq, error: entry.error };
    const open = async (): Promise<NodeJS.ReadableStream> => {
      if (entry.error) {
        throw new Error(entry.error);
      }
      const dataStart = await dataStartOffset(filePath, entry);
      return openZipEntry(filePath, entry, dataStart, options.onBytes, counter);
    };
    await handler(info, open);
  }
  return { entries: visited };
}

// central-directory names, for the sampling set
export async function listZipNames(filePath: string): Promise<string[]> {
  const { entries } = await readCentralDirectory(filePath);
  return entries.filter((e) => !e.name.endsWith('/')).map((e) => e.name);
}

// ---------- tgz ----------

class ByteSource {
  private buf: Buffer = Buffer.alloc(0);
  private iterator: AsyncIterator<Buffer>;
  private ended = false;
  offset = 0;

  constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  private async fill(n: number): Promise<void> {
    while (this.buf.length < n && !this.ended) {
      const { value, done } = await this.iterator.next();
      if (done) {
        this.ended = true;
        break;
      }
      this.buf = Buffer.concat([this.buf, value as Buffer]);
    }
  }

  async read(n: number): Promise<Buffer> {
    await this.fill(n);
    if (this.buf.length < n) {
      const err = new Error('unexpected end of tar stream') as Error & { byteOffset: number };
      err.byteOffset = this.offset;
      throw err;
    }
    const out = this.buf.subarray(0, n) as Buffer;
    this.buf = this.buf.subarray(n) as Buffer;
    this.offset += n;
    return out;
  }

  async pipe(n: number, dst: Writable): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      const chunk = await this.read(Math.min(remaining, 1 << 20));
      remaining -= chunk.length;
      if (!dst.write(chunk)) {
        await once(dst, 'drain');
      }
    }
  }

  async discard(n: number): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      const chunk = await this.read(Math.min(remaining, 1 << 20));
      remaining -= chunk.length;
    }
  }

  atEnd(): boolean {
    return this.ended && this.buf.length === 0;
  }
}

function parseOctal(field: Buffer): number {
  if (field.length > 0 && field[0] & 0x80) {
    // GNU base-256
    let value = 0n;
    for (let i = 0; i < field.length; i++) {
      value = (value << 8n) | BigInt(field[i] & (i === 0 ? 0x7f : 0xff));
    }
    return Number(value);
  }
  const text = field.toString('ascii').replace(/\0.*$/, '').trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function cString(field: Buffer): string {
  const zero = field.indexOf(0);
  return field.subarray(0, zero === -1 ? field.length : zero).toString('utf8');
}

function verifyChecksum(header: Buffer): boolean {
  const stored = parseOctal(header.subarray(148, 156));
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < 512; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : header[i];
    unsigned += b;
    signed += b < 128 ? b : b - 256;
  }
  return stored === unsigned || stored === signed;
}

function parsePaxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let i = 0;
  const text = data.toString('utf8');
  while (i < text.length) {
    const space = text.indexOf(' ', i);
    if (space === -1) {
      break;
    }
    const len = Number(text.slice(i, space));
    if (!Number.isFinite(len) || len <= 0) {
      break;
    }
    const record = text.slice(space + 1, i + len - 1);
    const eq = record.indexOf('=');
    if (eq !== -1) {
      records.set(record.slice(0, eq), record.slice(eq + 1));
    }
    i += len;
  }
  return records;
}

async function walkTgz(filePath: string, handler: EntryHandler, options: WalkOptions): Promise<{ entries: number }> {
  const raw = createReadStream(filePath, { highWaterMark: 1 << 20 });
  let compressed = 0;
  raw.on('data', (chunk: string | Buffer) => {
    compressed += (chunk as Buffer).length;
    options.onBytes?.(compressed);
  });
  const gunzip = createGunzip({ chunkSize: 1 << 20 });
  raw.pipe(gunzip);
  const source = new ByteSource(gunzip);

  let visited = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  let paxSize: number | null = null;
  let paxMtime: number | null = null;

  const finish = () => {
    gunzip.destroy();
    raw.destroy();
  };

  try {
    while (true) {
      if (options.signal?.aborted) {
        throw new Error('aborted');
      }
      const header = await source.read(512).catch((error: Error & { byteOffset?: number }) => {
        if (source.atEnd()) {
          return null;
        }
        throw error;
      });
      if (header === null || header.every((b) => b === 0)) {
        break;
      }
      if (!verifyChecksum(header)) {
        const err = new Error('bad tar header checksum') as Error & { byteOffset: number };
        err.byteOffset = source.offset - 512;
        throw err;
      }

      const type = String.fromCodePoint(header[156]);
      const size = paxSize ?? parseOctal(header.subarray(124, 136));
      const dataBlocks = Math.ceil(size / 512) * 512;

      if (type === 'L') {
        longName = cString(await source.read(dataBlocks)).slice(0, size);
        continue;
      }
      if (type === 'K') {
        await source.discard(dataBlocks);
        continue;
      }
      if (type === 'x') {
        const paxData = await source.read(dataBlocks);
        const records = parsePaxRecords(paxData.subarray(0, size));
        paxPath = records.get('path') ?? null;
        paxSize = records.has('size') ? Number(records.get('size')!) : null;
        paxMtime = records.has('mtime') ? Number(records.get('mtime')!) : null;
        continue;
      }
      if (type === 'g') {
        await source.discard(dataBlocks);
        continue;
      }

      const namePart = cString(header.subarray(0, 100));
      const prefix = cString(header.subarray(345, 500));
      const name = paxPath ?? longName ?? (prefix ? `${prefix}/${namePart}` : namePart);
      const mtime = paxMtime ?? parseOctal(header.subarray(136, 148));

      longName = null;
      paxPath = null;
      const entrySize = size;
      paxSize = null;
      paxMtime = null;

      const isFile = ['0', '\0', '7'].includes(type);
      const pad = dataBlocks - entrySize;
      if (!isFile) {
        await source.discard(dataBlocks);
        continue;
      }

      if (options.only && !options.only.has(name)) {
        await source.discard(dataBlocks);
        continue;
      }

      visited++;
      const info: ArchiveEntryInfo = { path: name, size: entrySize, mtime: mtime ? new Date(mtime * 1000) : null, seq: visited - 1, error: null };
      let opened = false;
      let pump: Promise<void> = Promise.resolve();
      // eslint-disable-next-line @typescript-eslint/require-await -- must satisfy the async EntryHandler opener signature
      const open = async (): Promise<NodeJS.ReadableStream> => {
        opened = true;
        const pt = new PassThrough();
        pump = source.pipe(entrySize, pt).then(() => {
          pt.end();
        });
        return pt;
      };
      await handler(info, open);
      if (opened) {
        await pump;
        await source.discard(pad);
      } else {
        await source.discard(dataBlocks);
      }
    }
    return { entries: visited };
  } finally {
    finish();
  }
}

export async function walkArchive(
  filePath: string,
  kind: ArchiveKind,
  handler: EntryHandler,
  options: WalkOptions = {},
): Promise<{ entries: number }> {
  return kind === 'zip' ? walkZip(filePath, handler, options) : walkTgz(filePath, handler, options);
}

export async function readArchiveEntry(
  filePath: string,
  kind: ArchiveKind,
  entryPath: string,
  maxBytes: number,
): Promise<Buffer | null> {
  let result: Buffer | null = null;
  await walkArchive(
    filePath,
    kind,
    async (entry, open) => {
      if (entry.path !== entryPath || result !== null || entry.error) {
        return;
      }
      const stream = await open();
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        chunks.push(chunk);
        total += chunk.length;
        if (total >= maxBytes) {
          break;
        }
      }
      result = Buffer.concat(chunks).subarray(0, maxBytes);
    },
    { only: new Set([entryPath]) },
  );
  return result;
}
