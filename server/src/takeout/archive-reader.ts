import { PassThrough, Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createGunzip, createInflateRaw } from 'node:zlib';
import {
  ArchiveChangedError,
  ArchiveDataError,
  EntryDataError,
  GzipIntegrityError,
  PartMissingError,
} from 'src/takeout/errors';
import { FileSource, FileSourceOptions, newReadMeter } from 'src/takeout/file-source';
import {
  ArchiveEntryInfo,
  ArchiveKind,
  EntryHandler,
  ReadMeter,
  WalkOptions,
  WalkResult,
  WalkSourceOptions,
} from 'src/takeout/types';

// Single-pass archive reader (design 6.7). Every stream is joined with pipeline or has an error listener from the
// moment it exists, so no archive or filesystem error can surface as an unhandled 'error' event or rejection (I11).

const MiB = 1024 * 1024;
const DEFAULT_ZIP_SEEK_GAP = 8 * MiB;
const EOCD_SIG = 0x06_05_4b_50;
const EOCD64_LOCATOR_SIG = 0x07_06_4b_50;
const EOCD64_SIG = 0x06_06_4b_50;
const CD_SIG = 0x02_01_4b_50;
const LOCAL_SIG = 0x04_03_4b_50;
const MAX_EOCD = 65_557;
const noop = () => {};

// CP437 high range (0x80..0xFF) for zip names without a UTF-8 flag or Unicode Path extra.
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
  '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩' +
  '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

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

function isZlibError(error: unknown): error is Error & { code: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('Z_');
}

function isReaderError(error: unknown): boolean {
  return (
    error instanceof ArchiveDataError ||
    error instanceof GzipIntegrityError ||
    error instanceof EntryDataError ||
    error instanceof ArchiveChangedError ||
    error instanceof PartMissingError
  );
}

function sourceOptions(options: WalkOptions, meter: ReadMeter): FileSourceOptions {
  const source: WalkSourceOptions = options.source ?? {};
  return {
    chunk: source.chunk,
    depth: source.depth,
    retryBudgetMs: source.retryBudgetMs,
    backoffMs: source.backoffMs,
    memory: source.memory ?? null,
    fs: source.fs,
    clock: source.clock,
    fingerprint: options.fingerprint ?? null,
    signal: options.signal,
    throttleMBps: options.throttleMBps ?? null,
    throttle: source.throttle ?? null,
    gate: source.gate ?? null,
    liveDepth: source.liveDepth,
    meter,
  };
}

// ---------- zip: central directory ----------

export interface ZipDirectoryEntry {
  name: string;
  nameBytes: Buffer;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  mtime: Date | null;
  /** index in local-offset order, directories included */
  seq: number;
  error: string | null;
  isDirectory: boolean;
}

export interface ZipDirectory {
  /** in local-offset order (seq order) */
  entries: ZipDirectoryEntry[];
  cdOffset: number;
  cdSize: number;
  size: number;
  /** bytes read for the EOCD tail, zip64 records and the central directory */
  bytesRead: number;
}

async function parseZipDirectory(
  readAt: (pos: number, len: number) => Promise<Buffer>,
  size: number,
): Promise<ZipDirectory> {
  let bytesRead = 0;
  const read = async (pos: number, len: number) => {
    const buf = await readAt(pos, len);
    bytesRead += len;
    return buf;
  };

  if (size < 22) {
    throw new ArchiveDataError('not a zip file (too small for an end of central directory record)', 0);
  }
  const tailLen = Math.min(MAX_EOCD, size);
  const tail = await read(size - tailLen, tailLen);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new ArchiveDataError(
      'zip end of central directory not found (the file is truncated or still being copied)',
      size,
    );
  }

  let cdEntries = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  if (cdEntries === 0xff_ff || cdOffset === 0xff_ff_ff_ff || cdSize === 0xff_ff_ff_ff) {
    const locator = eocd - 20;
    if (locator >= 0 && tail.readUInt32LE(locator) === EOCD64_LOCATOR_SIG) {
      const z64Offset = Number(tail.readBigUInt64LE(locator + 8));
      if (z64Offset + 56 > size) {
        throw new ArchiveDataError('zip64 end of central directory is outside the file', z64Offset);
      }
      const head = await read(z64Offset, 56);
      if (head.readUInt32LE(0) !== EOCD64_SIG) {
        throw new ArchiveDataError('zip64 end of central directory record not found', z64Offset);
      }
      cdEntries = Number(head.readBigUInt64LE(32));
      cdSize = Number(head.readBigUInt64LE(40));
      cdOffset = Number(head.readBigUInt64LE(48));
    }
  }

  if (cdOffset + cdSize > size) {
    throw new ArchiveDataError('zip central directory is outside the file (the file is truncated)', cdOffset);
  }
  const cd = cdSize > 0 ? await read(cdOffset, cdSize) : Buffer.alloc(0);

  const parsed: Array<ZipDirectoryEntry & { cdIndex: number }> = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === CD_SIG) {
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const modTime = cd.readUInt16LE(p + 12);
    const modDate = cd.readUInt16LE(p + 14);
    const crc = cd.readUInt32LE(p + 16);
    let compressedSize = cd.readUInt32LE(p + 20);
    let uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) {
      break;
    }
    const nameBytes = Buffer.from(cd.subarray(p + 46, p + 46 + nameLen));
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    const fields = readExtra(extra);

    const z64 = fields.get(0x00_01);
    if (z64) {
      let o = 0;
      if (uncompressedSize === 0xff_ff_ff_ff && o + 8 <= z64.length) {
        uncompressedSize = Number(z64.readBigUInt64LE(o));
        o += 8;
      }
      if (compressedSize === 0xff_ff_ff_ff && o + 8 <= z64.length) {
        compressedSize = Number(z64.readBigUInt64LE(o));
        o += 8;
      }
      if (localOffset === 0xff_ff_ff_ff && o + 8 <= z64.length) {
        localOffset = Number(z64.readBigUInt64LE(o));
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

    parsed.push({
      name,
      nameBytes,
      method,
      flags,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      mtime: dosDateTime(modTime, modDate),
      seq: 0,
      error,
      isDirectory: name.endsWith('/'),
      cdIndex: parsed.length,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  if (parsed.length % 65_536 !== cdEntries % 65_536) {
    throw new ArchiveDataError(
      `zip central directory is damaged (${parsed.length} of ${cdEntries} entries readable)`,
      cdOffset + p,
    );
  }

  parsed.sort((a, b) => a.localOffset - b.localOffset || a.cdIndex - b.cdIndex);
  const entries: ZipDirectoryEntry[] = parsed.map(({ cdIndex: _cdIndex, ...entry }, index) => ({
    ...entry,
    seq: index,
  }));
  return { entries, cdOffset, cdSize, size, bytesRead };
}

/** Tail and central directory only (no entry data) */
export async function readZipDirectory(
  filePath: string,
  options: Pick<WalkOptions, 'signal' | 'source' | 'fingerprint' | 'meter'> = {},
): Promise<ZipDirectory> {
  const meter = options.meter ?? newReadMeter();
  const src = await FileSource.open(
    filePath,
    sourceOptions({ ...options, source: { ...options.source, depth: 1 } }, meter),
  );
  try {
    return await parseZipDirectory((pos, len) => src.readAt(pos, len), src.size);
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    throw error;
  } finally {
    src.destroy();
  }
}

// ---------- zip: sequential walk ----------

/** Pull-based cursor over the sequential range of a FileSource, with gap skipping */
class Puller {
  private chunk: Buffer | null = null;
  private off = 0;
  /** absolute file offset of the next byte */
  pos: number;

  constructor(
    private readonly src: FileSource,
    private readonly seekGap: number,
  ) {
    this.pos = src.position;
  }

  private buffered(): number {
    return this.chunk ? this.chunk.length - this.off : 0;
  }

  async takeUpTo(n: number): Promise<Buffer | null> {
    if (n <= 0) {
      return Buffer.alloc(0);
    }
    if (this.buffered() === 0) {
      const next = await this.src.next();
      if (!next) {
        return null;
      }
      this.chunk = next;
      this.off = 0;
    }
    const take = Math.min(n, this.buffered());
    const out = this.chunk!.subarray(this.off, this.off + take);
    this.off += take;
    this.pos += take;
    if (this.off >= this.chunk!.length) {
      this.chunk = null;
      this.off = 0;
    }
    return out;
  }

  async take(n: number, what: string): Promise<Buffer> {
    const first = await this.takeUpTo(n);
    if (!first) {
      throw new EntryDataError(`${what} extends past the central directory`, this.pos);
    }
    if (first.length === n) {
      return first;
    }
    const out = Buffer.allocUnsafe(n);
    first.copy(out);
    let filled = first.length;
    while (filled < n) {
      const more = await this.takeUpTo(n - filled);
      if (!more) {
        throw new EntryDataError(`${what} extends past the central directory`, this.pos);
      }
      more.copy(out, filled);
      filled += more.length;
    }
    return out;
  }

  async moveTo(target: number): Promise<void> {
    if (target === this.pos) {
      return;
    }
    const ahead = target - this.pos;
    if (ahead > 0 && ahead <= this.buffered()) {
      this.off += ahead;
      this.pos = target;
      if (this.off >= this.chunk!.length) {
        this.chunk = null;
        this.off = 0;
      }
      return;
    }
    if (ahead < 0 || ahead - this.buffered() > this.seekGap) {
      this.chunk = null;
      this.off = 0;
      this.src.seek(target);
      this.pos = target;
      return;
    }
    let left = ahead;
    while (left > 0) {
      const dropped = await this.takeUpTo(Math.min(left, MiB));
      if (!dropped) {
        // the next entry starts past the central directory: the entry read reports it
        this.pos = target;
        return;
      }
      left -= dropped.length;
    }
  }
}

async function readLocalHeader(puller: Puller, entry: ZipDirectoryEntry): Promise<number> {
  const header = await puller.take(30, 'local header');
  if (header.readUInt32LE(0) !== LOCAL_SIG) {
    throw new EntryDataError('bad local header signature', entry.localOffset);
  }
  const flags = header.readUInt16LE(6);
  const method = header.readUInt16LE(8);
  const crc = header.readUInt32LE(14);
  let compressedSize = header.readUInt32LE(18);
  let uncompressedSize = header.readUInt32LE(22);
  const nameLen = header.readUInt16LE(26);
  const extraLen = header.readUInt16LE(28);
  const rest = await puller.take(nameLen + extraLen, 'local header');
  if (!rest.subarray(0, nameLen).equals(entry.nameBytes)) {
    throw new EntryDataError('local header name differs from the central directory', entry.localOffset);
  }
  if (method !== entry.method) {
    throw new EntryDataError('local header compression method differs from the central directory', entry.localOffset);
  }
  if ((flags & 0x08) === 0) {
    if (compressedSize === 0xff_ff_ff_ff || uncompressedSize === 0xff_ff_ff_ff) {
      const z64 = readExtra(rest.subarray(nameLen)).get(0x00_01);
      let o = 0;
      if (z64 && uncompressedSize === 0xff_ff_ff_ff && o + 8 <= z64.length) {
        uncompressedSize = Number(z64.readBigUInt64LE(o));
        o += 8;
      }
      if (z64 && compressedSize === 0xff_ff_ff_ff && o + 8 <= z64.length) {
        compressedSize = Number(z64.readBigUInt64LE(o));
      }
    }
    if (compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize || crc !== entry.crc32) {
      throw new EntryDataError('local header sizes or CRC differ from the central directory', entry.localOffset);
    }
  }
  return entry.localOffset + 30 + nameLen + extraLen;
}

interface OpenedEntry {
  stream: Readable;
  consumed: () => number;
  settled: () => Promise<void>;
}

/** The data of one zip entry: compressed bytes -> inflate -> length and CRC-32 check against the central directory */
function zipEntryStream(puller: Puller, entry: ZipDirectoryEntry, dataStart: number): OpenedEntry {
  let remaining = entry.compressedSize;
  let busy: Promise<void> | null = null;
  const pull = () => {
    if (busy) {
      return;
    }
    if (remaining === 0) {
      raw.push(null);
      return;
    }
    busy = puller
      .takeUpTo(Math.min(remaining, MiB))
      .then((buf) => {
        busy = null;
        if (!buf) {
          raw.destroy(new EntryDataError('entry data extends past the central directory', puller.pos));
          return;
        }
        remaining -= buf.length;
        raw.push(buf);
        if (remaining === 0) {
          raw.push(null);
        }
      })
      .catch((error: unknown) => {
        busy = null;
        raw.destroy(error as Error);
      });
  };
  const raw: Readable = new Readable({ read: pull });

  let crc = 0;
  let length = 0;
  const checker = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      crc = crc32(chunk, crc);
      length += chunk.length;
      if (length > entry.uncompressedSize) {
        callback(new EntryDataError('entry is longer than the central directory says', dataStart));
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (length !== entry.uncompressedSize) {
        callback(
          new EntryDataError(
            `entry has ${length} bytes, the central directory says ${entry.uncompressedSize}`,
            dataStart,
          ),
        );
      } else if (crc >>> 0 === entry.crc32 >>> 0) {
        callback();
      } else {
        callback(new EntryDataError('CRC-32 mismatch', dataStart));
      }
    },
  });

  const stages: Transform[] = entry.method === 8 ? [createInflateRaw()] : [];
  let failed = false;
  const fail = (error: unknown) => {
    if (failed) {
      return;
    }
    failed = true;
    raw.destroy();
    for (const stage of stages) {
      stage.destroy();
    }
    checker.destroy(error as Error);
  };
  raw.on('error', (error) => fail(error));
  for (const stage of stages) {
    stage.on('error', (error) =>
      fail(isZlibError(error) ? new EntryDataError(`inflate failed: ${error.message}`, dataStart) : error),
    );
  }
  // the consumer listens too; this one only guarantees that an unconsumed stream never crashes the process
  checker.on('error', noop);
  const rawClosed = new Promise<void>((resolve) => raw.once('close', resolve));
  checker.once('close', () => {
    raw.destroy();
    for (const stage of stages) {
      stage.destroy();
    }
  });

  let chain: Readable = raw;
  for (const stage of stages) {
    chain = chain.pipe(stage);
  }
  chain.pipe(checker);

  return {
    stream: checker,
    consumed: () => entry.compressedSize - remaining,
    settled: async () => {
      await rawClosed;
      while (busy) {
        await busy.catch(noop);
      }
    },
  };
}

async function walkZip(filePath: string, handler: EntryHandler, options: WalkOptions): Promise<WalkResult> {
  const meter = options.meter ?? newReadMeter();
  const src = await FileSource.open(filePath, sourceOptions(options, meter));
  let visited = 0;
  try {
    const directory = await parseZipDirectory((pos, len) => src.readAt(pos, len), src.size);
    let list = directory.entries;
    if (options.startSeq !== undefined) {
      const start = options.startSeq;
      list = list.filter((entry) => entry.seq >= start);
    }
    if (options.seqs) {
      const wanted = options.seqs;
      list = list.filter((entry) => wanted.has(entry.seq));
    }
    list = list.filter((entry) => !entry.isDirectory && (!options.only || options.only.has(entry.name)));
    if (list.length === 0) {
      meter.position = src.size;
      return { entries: 0, trailerVerified: false };
    }

    src.setRange(list[0].localOffset, directory.cdOffset);
    const puller = new Puller(src, options.zipSeekGap ?? DEFAULT_ZIP_SEEK_GAP);
    let stopped = false;
    for (const entry of list) {
      if (options.signal?.aborted) {
        throw options.signal.reason;
      }
      await puller.moveTo(entry.localOffset);

      let headerError: string | null = null;
      let dataStart = entry.localOffset + 30 + entry.nameBytes.length;
      if (!entry.error) {
        try {
          dataStart = await readLocalHeader(puller, entry);
        } catch (error) {
          if (!(error instanceof EntryDataError)) {
            throw error;
          }
          headerError = error.message;
        }
      }
      const endOffset = dataStart + entry.compressedSize;
      const info: ArchiveEntryInfo = {
        path: entry.name,
        size: entry.uncompressedSize,
        mtime: entry.mtime,
        seq: entry.seq,
        error: entry.error ?? headerError,
        endOffset,
      };
      visited++;

      let opened: OpenedEntry | null = null;
      // eslint-disable-next-line @typescript-eslint/require-await -- must satisfy the async opener signature
      const open = async (): Promise<NodeJS.ReadableStream> => {
        if (info.error) {
          throw new EntryDataError(info.error, entry.localOffset);
        }
        if (opened) {
          throw new Error(`entry ${entry.name} opened twice`);
        }
        opened = zipEntryStream(puller, entry, dataStart);
        return opened.stream;
      };
      try {
        await handler(info, open);
      } finally {
        const done = opened as OpenedEntry | null;
        if (done) {
          done.stream.destroy();
          await done.settled();
        }
      }
      if (!headerError) {
        await puller.moveTo(Math.max(puller.pos, Math.min(endOffset, directory.cdOffset)));
      }
      meter.position = Math.max(meter.position, Math.min(endOffset, src.size));
      await options.afterEntry?.(info, endOffset);
      if ((options.untilSeq !== undefined && entry.seq >= options.untilSeq) || options.shouldStop?.()) {
        stopped = true;
        break;
      }
    }
    if (!stopped) {
      // central directory and EOCD tail were read at the start: the whole file is covered
      meter.position = src.size;
    }
    return { entries: visited, trailerVerified: false };
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    throw error;
  } finally {
    src.destroy();
  }
}

// ---------- tgz ----------

/**
 * A chunk queue over gunzip's output (fix F12): read(n) returns a zero-copy subarray when the bytes lie in one chunk
 * and copies only when they straddle chunks; chunks are dropped as soon as they are consumed.
 */
class ByteSource {
  private chunks: Buffer[] = [];
  private head = 0;
  private available = 0;
  private ended = false;
  private readonly iterator: AsyncIterator<Buffer>;
  /** uncompressed bytes consumed */
  offset = 0;

  constructor(
    stream: Readable,
    private readonly compressedOffset: () => number,
  ) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  private async pull(): Promise<boolean> {
    if (this.ended) {
      return false;
    }
    const { value, done } = await this.iterator.next();
    if (done) {
      this.ended = true;
      return false;
    }
    const chunk = value as Buffer;
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.available += chunk.length;
    }
    return true;
  }

  private truncated(): ArchiveDataError {
    return new ArchiveDataError('unexpected end of tar stream (the archive is truncated)', this.compressedOffset());
  }

  /** Bytes still buffered plus whether the stream ended: used to tell a clean end from a cut */
  async atEnd(): Promise<boolean> {
    while (this.available === 0) {
      if (!(await this.pull())) {
        return true;
      }
    }
    return false;
  }

  async read(n: number): Promise<Buffer> {
    while (this.available < n) {
      if (!(await this.pull())) {
        throw this.truncated();
      }
    }
    const first = this.chunks[0];
    let out: Buffer;
    if (first.length - this.head >= n) {
      out = first.subarray(this.head, this.head + n);
      this.head += n;
      if (this.head === first.length) {
        this.chunks.shift();
        this.head = 0;
      }
    } else {
      out = Buffer.allocUnsafe(n);
      let filled = 0;
      while (filled < n) {
        const chunk = this.chunks[0];
        const take = Math.min(n - filled, chunk.length - this.head);
        chunk.copy(out, filled, this.head, this.head + take);
        filled += take;
        this.head += take;
        if (this.head === chunk.length) {
          this.chunks.shift();
          this.head = 0;
        }
      }
    }
    this.available -= n;
    this.offset += n;
    return out;
  }

  /** Up to `max` bytes from the head chunk, zero-copy */
  async readSome(max: number): Promise<Buffer> {
    while (this.available === 0) {
      if (!(await this.pull())) {
        throw this.truncated();
      }
    }
    const first = this.chunks[0];
    const take = Math.min(max, first.length - this.head);
    const out = first.subarray(this.head, this.head + take);
    this.head += take;
    if (this.head === first.length) {
      this.chunks.shift();
      this.head = 0;
    }
    this.available -= take;
    this.offset += take;
    return out;
  }

  /**
   * Copy `n` bytes into `dst`. A consumer that destroyed its stream (fix F9) does not hang the walk: waiting for
   * 'drain' also ends on 'close' and 'error', and the rest of the entry is then discarded.
   */
  async pipe(n: number, dst: Writable): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      const chunk = await this.readSome(Math.min(remaining, MiB));
      remaining -= chunk.length;
      if (dst.destroyed || dst.writableEnded) {
        continue;
      }
      if (!dst.write(chunk)) {
        await waitDrainOrClose(dst);
      }
    }
  }

  async discard(n: number): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      const chunk = await this.readSome(Math.min(remaining, MiB));
      remaining -= chunk.length;
    }
  }

  /** Read to the end of the stream (tgz: so gunzip verifies the trailer of every member) */
  async drainToEnd(): Promise<void> {
    this.chunks = [];
    this.head = 0;
    this.available = 0;
    while (await this.pull()) {
      this.offset += this.available;
      this.chunks = [];
      this.available = 0;
    }
  }
}

function waitDrainOrClose(dst: Writable): Promise<void> {
  if (dst.destroyed) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const done = () => {
      dst.off('drain', done);
      dst.off('close', done);
      dst.off('error', done);
      resolve();
    };
    dst.on('drain', done);
    dst.on('close', done);
    dst.on('error', done);
  });
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

function classifyTgzError(error: unknown, offset: number): unknown {
  if (isReaderError(error)) {
    const withOffset = error as { byteOffset?: number | null };
    if ('byteOffset' in withOffset && withOffset.byteOffset === null) {
      withOffset.byteOffset = offset;
    }
    return error;
  }
  if (isZlibError(error)) {
    if (/incorrect (data|length) check/i.test(error.message)) {
      return new GzipIntegrityError(error.message, offset);
    }
    return new ArchiveDataError(`gzip: ${error.message}`, offset);
  }
  return error;
}

async function walkTgz(filePath: string, handler: EntryHandler, options: WalkOptions): Promise<WalkResult> {
  const meter = options.meter ?? newReadMeter();
  const src = await FileSource.open(filePath, sourceOptions(options, meter));
  src.setRange(0, src.size);
  const readable = src.toReadable();
  const gunzip = createGunzip({ chunkSize: MiB });
  const internal = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, internal.signal]) : internal.signal;
  // every source error and every abort reaches gunzip, and through it the reader below (fix F8)
  const piped = pipeline(readable, gunzip, { signal });
  piped.catch(noop);
  const source = new ByteSource(gunzip, () => gunzip.bytesWritten);

  let visited = 0;
  let fileSeq = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  let paxSize: number | null = null;
  let paxMtime: number | null = null;

  try {
    for (;;) {
      if (options.signal?.aborted) {
        throw options.signal.reason;
      }
      if (await source.atEnd()) {
        // the stream ended at a header boundary without end-of-archive blocks: gunzip ended, trailer checked
        break;
      }
      const header = await source.read(512);
      if (header.every((b) => b === 0)) {
        break;
      }
      if (!verifyChecksum(header)) {
        throw new ArchiveDataError('bad tar header checksum', gunzip.bytesWritten);
      }

      const type = String.fromCodePoint(header[156]);
      const size = paxSize ?? parseOctal(header.subarray(124, 136));
      const dataBlocks = Math.ceil(size / 512) * 512;

      if (type === 'L') {
        longName = cString(await source.read(dataBlocks)).slice(0, size);
        continue;
      }
      if (type === 'K' || type === 'g') {
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

      const namePart = cString(header.subarray(0, 100));
      const prefix = cString(header.subarray(345, 500));
      const name = paxPath ?? longName ?? (prefix ? `${prefix}/${namePart}` : namePart);
      const mtime = paxMtime ?? parseOctal(header.subarray(136, 148));
      longName = null;
      paxPath = null;
      paxSize = null;
      paxMtime = null;

      const isFile = ['0', '\0', '7'].includes(type);
      if (!isFile) {
        await source.discard(dataBlocks);
        continue;
      }
      // seq counts every regular file, whatever `only` or `untilSeq` select (fix F1)
      const seq = fileSeq++;
      if (options.only && !options.only.has(name)) {
        await source.discard(dataBlocks);
        continue;
      }

      visited++;
      const info: ArchiveEntryInfo = {
        path: name,
        size,
        mtime: mtime ? new Date(mtime * 1000) : null,
        seq,
        error: null,
        endOffset: null,
      };
      let target: PassThrough | null = null;
      let pump: Promise<void> = Promise.resolve();
      // eslint-disable-next-line @typescript-eslint/require-await -- must satisfy the async opener signature
      const open = async (): Promise<NodeJS.ReadableStream> => {
        if (target) {
          throw new Error(`entry ${name} opened twice`);
        }
        const pt = new PassThrough({ highWaterMark: MiB });
        pt.on('error', noop);
        target = pt;
        pump = source
          .pipe(size, pt)
          .catch((error: unknown) => {
            pt.destroy(error as Error);
            throw error;
          })
          .then(() => {
            pt.end();
          });
        // handled at creation: the walker awaits it after the handler and rethrows there
        pump.catch(noop);
        return pt;
      };

      await handler(info, open);
      const opened = target as PassThrough | null;
      if (opened) {
        // a consumer that stopped early gets the rest of the entry discarded
        opened.destroy();
        await pump;
        await source.discard(dataBlocks - size);
      } else {
        await source.discard(dataBlocks);
      }
      info.endOffset = gunzip.bytesWritten;
      await options.afterEntry?.(info, info.endOffset);
      if ((options.untilSeq !== undefined && seq >= options.untilSeq) || options.shouldStop?.()) {
        return { entries: visited, trailerVerified: false };
      }
    }

    // read gunzip to EOF: it verifies the CRC-32 and length of every gzip member (fix F10)
    await source.drainToEnd();
    await piped;
    meter.position = src.size;
    return { entries: visited, trailerVerified: true };
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    throw classifyTgzError(error, gunzip.bytesWritten);
  } finally {
    internal.abort();
    readable.destroy();
    gunzip.destroy();
    src.destroy();
  }
}

export async function walkArchive(
  filePath: string,
  kind: ArchiveKind,
  handler: EntryHandler,
  options: WalkOptions = {},
): Promise<WalkResult> {
  return kind === 'zip' ? walkZip(filePath, handler, options) : walkTgz(filePath, handler, options);
}

/** zip random access to the listed entries, in offset order, with the same checks as a walk */
export function readZipEntriesAt(
  filePath: string,
  seqs: Iterable<number>,
  handler: EntryHandler,
  options: WalkOptions = {},
): Promise<WalkResult> {
  return walkZip(filePath, handler, { ...options, seqs: new Set(seqs) });
}

export async function readArchiveEntry(
  filePath: string,
  kind: ArchiveKind,
  entryPath: string,
  maxBytes: number,
  options: WalkOptions = {},
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
    { ...options, only: new Set([entryPath]), shouldStop: () => result !== null },
  );
  return result;
}
