const WIDTH = 20;

// First 6 bytes as a number: exact in a double, and enough to order random SHA-1 values almost always.
function keyAt(buf: Buffer, offset: number): number {
  return buf.readUIntBE(offset, 6);
}

/**
 * A compact, immutable set of SHA-1 checksums: all values concatenated into one Buffer, sorted with Buffer.compare
 * order and deduplicated; `has` is a binary search. 20 bytes per checksum (1M checksums = 20 MB).
 */
export class ChecksumSet {
  private constructor(
    private readonly data: Buffer,
    readonly size: number,
  ) {}

  static empty(): ChecksumSet {
    return new ChecksumSet(Buffer.alloc(0), 0);
  }

  static from(checksums: Iterable<Buffer>): ChecksumSet {
    const list: Buffer[] = [];
    for (const checksum of checksums) {
      if (checksum?.length === WIDTH) {
        list.push(checksum);
      }
    }
    return ChecksumSet.build(list);
  }

  static async fromAsync(checksums: AsyncIterable<Buffer | null | undefined>): Promise<ChecksumSet> {
    const list: Buffer[] = [];
    for await (const checksum of checksums) {
      if (checksum?.length === WIDTH) {
        list.push(checksum);
      }
    }
    return ChecksumSet.build(list);
  }

  private static build(list: Buffer[]): ChecksumSet {
    const count = list.length;
    const raw = Buffer.allocUnsafe(count * WIDTH);
    for (let i = 0; i < count; i++) {
      list[i].copy(raw, i * WIDTH);
    }
    const keys = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      keys[i] = keyAt(raw, i * WIDTH);
    }
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      order[i] = i;
    }
    order.sort((a, b) => {
      const d = keys[a] - keys[b];
      if (d !== 0) {
        return d;
      }
      // buf.compare(target, tStart, tEnd, sStart, sEnd) orders the source range against the target range
      return raw.compare(raw, b * WIDTH, b * WIDTH + WIDTH, a * WIDTH, a * WIDTH + WIDTH);
    });

    const data = Buffer.allocUnsafe(count * WIDTH);
    let size = 0;
    for (let i = 0; i < count; i++) {
      const at = order[i] * WIDTH;
      if (size > 0 && raw.compare(data, (size - 1) * WIDTH, size * WIDTH, at, at + WIDTH) === 0) {
        continue;
      }
      raw.copy(data, size * WIDTH, at, at + WIDTH);
      size++;
    }
    return new ChecksumSet(size === count ? data : data.subarray(0, size * WIDTH), size);
  }

  has(checksum: Buffer | null | undefined): boolean {
    if (checksum?.length !== WIDTH) {
      return false;
    }
    let lo = 0;
    let hi = this.size - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = checksum.compare(this.data, mid * WIDTH, mid * WIDTH + WIDTH);
      if (cmp === 0) {
        return true;
      }
      if (cmp < 0) {
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return false;
  }
}
