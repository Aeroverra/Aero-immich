import { randomBytes } from 'node:crypto';
import { ChecksumSet } from 'src/takeout/checksum-set';
import { sha1 } from 'src/takeout/test-fixtures';
import { describe, expect, it } from 'vitest';

describe(ChecksumSet.name, () => {
  it('answers membership', () => {
    const a = sha1(Buffer.from('a'));
    const b = sha1(Buffer.from('b'));
    const c = sha1(Buffer.from('c'));
    const set = ChecksumSet.from([a, b]);
    expect(set.has(a)).toBe(true);
    expect(set.has(b)).toBe(true);
    expect(set.has(c)).toBe(false);
    expect(set.has(null)).toBe(false);
    expect(set.has(Buffer.from('short'))).toBe(false);
  });

  it('deduplicates', () => {
    const a = sha1(Buffer.from('a'));
    const set = ChecksumSet.from([a, Buffer.from(a), a]);
    expect(set.size).toBe(1);
    expect(set.has(a)).toBe(true);
  });

  it('handles the empty set', () => {
    expect(ChecksumSet.empty().has(sha1(Buffer.from('a')))).toBe(false);
    expect(ChecksumSet.from([]).size).toBe(0);
  });

  it('builds from an async iterable and ignores nulls', async () => {
    const a = sha1(Buffer.from('a'));
    const source: AsyncIterable<Buffer | null | undefined> = {
      [Symbol.asyncIterator]() {
        const values = [a, null, undefined][Symbol.iterator]();
        return { next: () => Promise.resolve(values.next()) };
      },
    };
    const set = await ChecksumSet.fromAsync(source);
    expect(set.size).toBe(1);
    expect(set.has(a)).toBe(true);
  });

  it('agrees with a Set of hex strings on random data, including values sharing a 6-byte prefix', () => {
    const values = Array.from({ length: 5000 }, () => randomBytes(20));
    const twin = Buffer.from(values[0]);
    twin[19] ^= 0xff;
    values.push(twin);
    const set = ChecksumSet.from(values);
    for (const value of values) {
      expect(set.has(value)).toBe(true);
    }
    for (let i = 0; i < 2000; i++) {
      const probe = randomBytes(20);
      expect(set.has(probe)).toBe(values.some((v) => v.equals(probe)));
    }
  });

  // well under a second on a laptop, but a busy CI runner took just over one: the generous bound still catches a
  // pathological build (a quadratic sort, a copy per comparison) without making the test depend on the runner
  it('builds a set of 1M random checksums in a few seconds at most', { timeout: 60_000 }, () => {
    const data = randomBytes(20 * 1_000_000);
    const list = Array.from({ length: 1_000_000 }, (_, i) => data.subarray(i * 20, i * 20 + 20));
    const start = performance.now();
    const set = ChecksumSet.from(list);
    const elapsed = performance.now() - start;
    expect(set.size).toBe(1_000_000);
    for (const i of [0, 123_456, 999_999]) {
      expect(set.has(list[i])).toBe(true);
    }
    expect(elapsed).toBeLessThan(5000);
  });
});
