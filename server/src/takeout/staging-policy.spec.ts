import { chooseReadMode, decideAfterHash, decideAfterProbe, hex, StagingView } from 'src/takeout/staging-policy';
import { sha1 } from 'src/takeout/test-fixtures';
import { describe, expect, it } from 'vitest';

const KiB = 1024;

function view(
  over: Partial<StagingView> & { budget?: boolean; server?: Buffer[]; staged?: string[] } = {},
): StagingView {
  const server = new Set((over.server ?? []).map((c) => hex(c)));
  const staged = new Set(over.staged);
  return {
    onServer: over.onServer ?? ((checksum) => server.has(hex(checksum))),
    hasBlobOrReserved: over.hasBlobOrReserved ?? ((h) => staged.has(h)),
    budgetAllows: over.budgetAllows ?? (() => over.budget ?? true),
    limits: over.limits ?? { bufferLimit: KiB, sampleBufferLimit: 4 * KiB },
  };
}

describe('chooseReadMode', () => {
  it('buffers entries up to the buffer limit', () => {
    expect(chooseReadMode(KiB, false, view())).toBe('buffer');
    expect(chooseReadMode(1, false, view({ budget: false }))).toBe('buffer');
  });

  it('buffers a sampling-set image above the buffer limit and below the sample limit', () => {
    expect(chooseReadMode(2 * KiB, true, view())).toBe('buffer');
    expect(chooseReadMode(4 * KiB, true, view())).toBe('buffer');
  });

  it('applies the large rules above the sample limit', () => {
    expect(chooseReadMode(4 * KiB + 1, true, view())).toBe('probe');
    expect(chooseReadMode(4 * KiB + 1, true, view({ budget: false }))).toBe('hashOnly');
  });

  it('probes a large entry when the budget allows it, hashes only when it does not', () => {
    expect(chooseReadMode(2 * KiB, false, view())).toBe('probe');
    expect(chooseReadMode(2 * KiB, false, view({ budget: false }))).toBe('hashOnly');
  });
});

describe('decideAfterProbe', () => {
  it('only hashes when the prefix matches present content, streams otherwise', () => {
    expect(decideAfterProbe(true)).toBe('hashOnly');
    expect(decideAfterProbe(false)).toBe('stream');
  });
});

describe('decideAfterHash', () => {
  const a = sha1(Buffer.from('a'));

  it('reports a server hit first', () => {
    expect(decideAfterHash(a, 10, 'buffer', view({ server: [a], staged: [hex(a)] }))).toBe('serverDuplicate');
  });

  it('reports content already staged or reserved', () => {
    expect(decideAfterHash(a, 10, 'buffer', view({ staged: [hex(a)] }))).toBe('stagedDuplicate');
    expect(decideAfterHash(a, 10, 'stream', view({ staged: [hex(a)] }))).toBe('stagedDuplicate');
  });

  it('defers new content read in hashOnly mode', () => {
    expect(decideAfterHash(a, 10, 'hashOnly', view())).toBe('deferred');
  });

  it('defers a buffered entry over the budget', () => {
    expect(decideAfterHash(a, 10, 'buffer', view({ budget: false }))).toBe('deferred');
  });

  it('stages everything else (stream mode reserved its budget up front)', () => {
    expect(decideAfterHash(a, 10, 'buffer', view())).toBe('stage');
    expect(decideAfterHash(a, 10, 'stream', view({ budget: false }))).toBe('stage');
  });
});
