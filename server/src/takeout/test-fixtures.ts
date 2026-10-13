import { createHash } from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';

// Hand-built zip and tar fixtures, so tests control flags, zip64, CP437, GNU long names and base-256 sizes.

export interface ZipInput {
  nameBytes: Buffer; // raw name bytes (may be CP437)
  data: Buffer;
  method?: 0 | 8;
  utf8Flag?: boolean;
  zip64?: boolean;
  /** CRC written to both headers instead of the real one (a corrupt entry) */
  crcOverride?: number;
  /** name written to the local header instead of nameBytes */
  localNameBytes?: Buffer;
  /** stored data written instead of the real (compressed) data, same length or shorter */
  storedOverride?: Buffer;
  /** bytes written before the local header (a gap between entries) */
  gapBefore?: number;
}

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xed_b8_83_20 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

export function buildZip(inputs: ZipInput[], options?: { zip64Eocd?: boolean }): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const input of inputs) {
    const method = input.method ?? 8;
    if (input.gapBefore) {
      locals.push(Buffer.alloc(input.gapBefore, 0x5a));
      offset += input.gapBefore;
    }
    const realStored = method === 0 ? input.data : deflateRawSync(input.data);
    const stored = input.storedOverride ?? realStored;
    const crc = input.crcOverride ?? crc32(input.data);
    const flags = input.utf8Flag ? 0x08_00 : 0;
    const zip64 = input.zip64 === true;

    const localExtra = zip64 ? buildZip64Extra(input.data.length, stored.length) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(zip64 ? 0xff_ff_ff_ff : stored.length, 18);
    local.writeUInt32LE(zip64 ? 0xff_ff_ff_ff : input.data.length, 22);
    const localName = input.localNameBytes ?? input.nameBytes;
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    locals.push(local, localName, localExtra, stored);

    const centralExtra = zip64 ? buildZip64Extra(input.data.length, stored.length, offset) : Buffer.alloc(0);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(zip64 ? 0xff_ff_ff_ff : stored.length, 20);
    central.writeUInt32LE(zip64 ? 0xff_ff_ff_ff : input.data.length, 24);
    central.writeUInt16LE(input.nameBytes.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(zip64 ? 0xff_ff_ff_ff : offset, 42);
    centrals.push(central, input.nameBytes, centralExtra);

    offset += local.length + localName.length + localExtra.length + stored.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const cdOffset = localPart.length;

  if (options?.zip64Eocd) {
    const eocd64 = Buffer.alloc(56);
    eocd64.writeUInt32LE(0x06_06_4b_50, 0);
    eocd64.writeBigUInt64LE(44n, 4);
    eocd64.writeUInt16LE(45, 12);
    eocd64.writeUInt16LE(45, 14);
    eocd64.writeBigUInt64LE(BigInt(inputs.length), 24);
    eocd64.writeBigUInt64LE(BigInt(inputs.length), 32);
    eocd64.writeBigUInt64LE(BigInt(centralPart.length), 40);
    eocd64.writeBigUInt64LE(BigInt(cdOffset), 48);
    const eocd64Offset = localPart.length + centralPart.length;
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07_06_4b_50, 0);
    locator.writeBigUInt64LE(BigInt(eocd64Offset), 8);
    locator.writeUInt32LE(1, 16);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06_05_4b_50, 0);
    eocd.writeUInt16LE(0xff_ff, 8);
    eocd.writeUInt16LE(0xff_ff, 10);
    eocd.writeUInt32LE(0xff_ff_ff_ff, 12);
    eocd.writeUInt32LE(0xff_ff_ff_ff, 16);
    return Buffer.concat([localPart, centralPart, eocd64, locator, eocd]);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(inputs.length, 8);
  eocd.writeUInt16LE(inputs.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

function buildZip64Extra(uncompressed: number, compressed: number, offset?: number): Buffer {
  const size = offset === undefined ? 16 : 24;
  const extra = Buffer.alloc(4 + size);
  extra.writeUInt16LE(0x00_01, 0);
  extra.writeUInt16LE(size, 2);
  extra.writeBigUInt64LE(BigInt(uncompressed), 4);
  extra.writeBigUInt64LE(BigInt(compressed), 12);
  if (offset !== undefined) {
    extra.writeBigUInt64LE(BigInt(offset), 20);
  }
  return extra;
}

export interface TarInput {
  name: string;
  data: Buffer;
  gnuLong?: boolean; // emit a GNU 'L' long-name header
  pax?: boolean; // emit a pax 'x' header with path and size
  base256Size?: boolean; // encode the size field as GNU base-256
}

function octal(value: number, length: number): Buffer {
  const str = value.toString(8).padStart(length - 1, '0') + '\0';
  return Buffer.from(str, 'ascii');
}

function base256(value: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  buf[0] = 0x80;
  let v = BigInt(value);
  for (let i = length - 1; i >= 1; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

function tarHeader(name: string, size: number, type: string, base256Size = false): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 'utf8');
  octal(0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  (base256Size ? base256(size, 12) : octal(size, 12)).copy(header, 124);
  octal(Math.floor(Date.now() / 1000), 12).copy(header, 136);
  header.write(type, 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  // checksum
  header.write(' '.repeat(8), 148, 'ascii');
  let sum = 0;
  for (const b of header) {
    sum += b;
  }
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return header;
}

function pad512(data: Buffer): Buffer {
  const rem = data.length % 512;
  return rem === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rem)]);
}

export function buildTar(inputs: TarInput[]): Buffer {
  const blocks: Buffer[] = [];
  for (const input of inputs) {
    if (input.gnuLong) {
      const nameBuf = Buffer.from(input.name + '\0', 'utf8');
      blocks.push(tarHeader('././@LongLink', nameBuf.length, 'L'), pad512(nameBuf));
    }
    if (input.pax) {
      const records = `path=${input.name}\nsize=${input.data.length}\n`;
      const withLen = paxWithLength(records);
      blocks.push(tarHeader('PaxHeader', withLen.length, 'x'), pad512(withLen));
    }
    blocks.push(tarHeader(input.name, input.data.length, '0', input.base256Size), pad512(input.data));
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks
  return Buffer.concat(blocks);
}

function paxWithLength(records: string): Buffer {
  // Each pax record is "<len> key=value\n" where len counts its own digits.
  const lines = records.trimEnd().split('\n');
  const out: string[] = [];
  for (const line of lines) {
    // len counts bytes, not characters
    const bytes = Buffer.byteLength(line, 'utf8');
    let len = bytes + 1 + 1; // space + newline
    len += String(len).length;
    // fixed-point: recompute if digit count changed
    while (String(len).length + bytes + 2 !== len) {
      len = String(len).length + bytes + 2;
    }
    out.push(`${len} ${line}\n`);
  }
  return Buffer.from(out.join(''), 'utf8');
}

export function buildTarGz(inputs: TarInput[]): Buffer {
  return gzipSync(buildTar(inputs));
}

// Concatenated gzip members (one gzip stream per tar half).
export function buildTarGzConcatenated(inputs: TarInput[]): Buffer {
  const tar = buildTar(inputs);
  const half = Math.floor(tar.length / 1024 / 2) * 1024 || 512;
  return Buffer.concat([gzipSync(tar.subarray(0, half)), gzipSync(tar.subarray(half))]);
}

export { crc32 as fixtureCrc32 };

/** Deterministic pseudo-random bytes (incompressible, so a gzip of them is mostly stored blocks) */
export function randomBytesSeeded(length: number, seed = 1): Buffer {
  const out = Buffer.allocUnsafe(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

export function sha1(data: Buffer): Buffer {
  return createHash('sha1').update(data).digest();
}
