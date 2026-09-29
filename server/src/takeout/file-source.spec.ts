import { ByteSemaphore } from 'src/takeout/byte-semaphore';
import { ArchiveChangedError, PartMissingError } from 'src/takeout/errors';
import { FileHandleLike, FileSource, FileSourceClock, FileSourceFs, newReadMeter } from 'src/takeout/file-source';
import { randomBytesSeeded } from 'src/takeout/test-fixtures';
import { describe, expect, it } from 'vitest';

const errno = (code: string) => Object.assign(new Error(code), { code });

interface FakeFile {
  data: Buffer;
  ctimeMs: number;
  ino: number;
}

type ReadHook = (call: { pos: number; len: number; n: number; handle: number }) => Promise<void> | void;

class FakeFs implements FileSourceFs {
  opens = 0;
  closes = 0;
  reads = 0;
  openHandles = new Set<number>();
  file: FakeFile | null;
  onRead: ReadHook = () => {};

  constructor(data: Buffer) {
    this.file = { data, ctimeMs: 1000, ino: 7 };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async open(): Promise<FileHandleLike> {
    if (!this.file) {
      throw errno('ENOENT');
    }
    const id = ++this.opens;
    this.openHandles.add(id);
    const file = this.file;
    return {
      read: async (buffer, offset, length, position) => {
        const n = ++this.reads;
        await this.onRead({ pos: position, len: length, n, handle: id });
        const end = Math.min(file.data.length, position + length);
        const count = Math.max(0, end - position);
        file.data.copy(buffer, offset, position, position + count);
        return { bytesRead: count };
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      stat: async () => ({ size: file.data.length, mtimeMs: 5000, ctimeMs: file.ctimeMs, ino: file.ino }),
      // eslint-disable-next-line @typescript-eslint/require-await
      close: async () => {
        this.closes++;
        this.openHandles.delete(id);
      },
    };
  }
}

/** A clock whose sleeps return at once and advance time */
class FakeClock implements FileSourceClock {
  t = 1_000_000;
  sleeps: number[] = [];
  now() {
    return this.t;
  }
  sleep(ms: number) {
    this.sleeps.push(ms);
    this.t += ms;
    return Promise.resolve();
  }
}

async function readAll(src: FileSource): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (;;) {
    const chunk = await src.next();
    if (!chunk) {
      return Buffer.concat(chunks);
    }
    chunks.push(Buffer.from(chunk));
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe(FileSource.name, () => {
  const data = randomBytesSeeded(10_000, 3);

  it('reads the range in order with readahead', async () => {
    const fs = new FakeFs(data);
    const src = await FileSource.open('x', { fs, chunk: 1000, depth: 3 });
    src.setRange(0, data.length);
    expect(await readAll(src)).toEqual(data);
    expect(src.meter.bytesRead).toBe(data.length);
    expect(src.position).toBe(data.length);
    src.destroy();
    await src.closed;
    expect(fs.openHandles.size).toBe(0);
  });

  it('retries EIO in place: every byte delivered once, transportRetries == 2', async () => {
    const fs = new FakeFs(data);
    const clock = new FakeClock();
    let failures = 0;
    fs.onRead = ({ pos }) => {
      if (!(pos === 3000 && failures < 2)) {
        return;
      }

      failures++;
      throw errno('EIO');
    };
    const src = await FileSource.open('x', { fs, clock, chunk: 1000, depth: 2 });
    src.setRange(0, data.length);
    expect(await readAll(src)).toEqual(data);
    expect(src.meter.transportRetries).toBe(2);
    expect(src.meter.bytesRead).toBe(data.length);
    expect(clock.sleeps).toEqual([1000, 2000]);
    src.destroy();
  });

  it('passes the error on once the transport budget is spent', async () => {
    const fs = new FakeFs(data);
    const clock = new FakeClock();
    fs.onRead = ({ pos }) => {
      if (pos === 2000) {
        throw errno('ETIMEDOUT');
      }
    };
    const src = await FileSource.open('x', { fs, clock, chunk: 1000, depth: 1, retryBudgetMs: 60_000 });
    src.setRange(0, data.length);
    await expect(readAll(src)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    // 1 + 2 + 5 + 10 + 30 + 60 >= 60 s
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000);
  });

  it('reopens on ESTALE and continues when the fingerprint is the same', async () => {
    const fs = new FakeFs(data);
    let stale = true;
    fs.onRead = ({ pos, handle }) => {
      if (!(pos === 4000 && handle === 1 && stale)) {
        return;
      }

      stale = false;
      throw errno('ESTALE');
    };
    const src = await FileSource.open('x', { fs, chunk: 1000, depth: 1 });
    src.setRange(0, data.length);
    expect(await readAll(src)).toEqual(data);
    expect(fs.opens).toBe(2);
    src.destroy();
    await src.closed;
    expect(fs.openHandles.size).toBe(0);
  });

  it('fails with ArchiveChangedError when the file changed before the reopen', async () => {
    const fs = new FakeFs(data);
    fs.onRead = ({ pos, handle }) => {
      if (!(pos === 4000 && handle === 1)) {
        return;
      }

      fs.file!.ctimeMs = 2000;
      throw errno('ESTALE');
    };
    const src = await FileSource.open('x', { fs, chunk: 1000, depth: 1 });
    src.setRange(0, data.length);
    await expect(readAll(src)).rejects.toBeInstanceOf(ArchiveChangedError);
  });

  it('fails with PartMissingError when the file is gone at the reopen', async () => {
    const fs = new FakeFs(data);
    fs.onRead = ({ pos, handle }) => {
      if (!(pos === 4000 && handle === 1)) {
        return;
      }

      fs.file = null;
      throw errno('ESTALE');
    };
    const src = await FileSource.open('x', { fs, chunk: 1000, depth: 1 });
    src.setRange(0, data.length);
    await expect(readAll(src)).rejects.toBeInstanceOf(PartMissingError);
  });

  it('fails with ArchiveChangedError on an early EOF', async () => {
    const fs = new FakeFs(data);
    const src = await FileSource.open('x', { fs, chunk: 1000, depth: 2 });
    src.setRange(0, data.length);
    const first = await src.next();
    expect(first).toEqual(data.subarray(0, 1000));
    fs.file!.data = data.subarray(0, 2500);
    await expect(readAll(src)).rejects.toBeInstanceOf(ArchiveChangedError);
  });

  it('rejects an open whose fingerprint differs from the expected one', async () => {
    const fs = new FakeFs(data);
    await expect(
      FileSource.open('x', { fs, fingerprint: { size: data.length, mtimeMs: 5000, ctimeMs: 999, ino: 7 } }),
    ).rejects.toBeInstanceOf(ArchiveChangedError);
    expect(fs.openHandles.size).toBe(0);
  });

  it('maps ENOENT at open to PartMissingError', async () => {
    const fs = new FakeFs(data);
    fs.file = null;
    await expect(FileSource.open('x', { fs })).rejects.toBeInstanceOf(PartMissingError);
  });

  it('seek drops the readahead and counts skipped bytes once', async () => {
    const fs = new FakeFs(data);
    const src = await FileSource.open('x', { fs, chunk: 1000, depth: 2 });
    src.setRange(0, data.length);
    expect(await src.next()).toEqual(data.subarray(0, 1000));
    // readahead now covers [1000, 3000)
    src.seek(6000);
    expect(src.meter.bytesSkipped).toBe(3000);
    expect(await src.next()).toEqual(data.subarray(6000, 7000));
    // inside the readahead: no bytes skipped, the chunk is trimmed
    src.seek(7500);
    expect(src.meter.bytesSkipped).toBe(3000);
    expect(await src.next()).toEqual(data.subarray(7500, 8000));
    src.seek(100);
    expect(await src.next()).toEqual(data.subarray(100, 1100));
    src.destroy();
  });

  it('reports pendingSince for a read that never returns, and destroy does not close its handle', async () => {
    const fs = new FakeFs(data);
    const clock = new FakeClock();
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    fs.onRead = ({ pos }) => (pos === 0 ? stuck : undefined);
    const meter = newReadMeter();
    const src = await FileSource.open('x', { fs, clock, chunk: 1000, depth: 1, meter });
    src.setRange(0, data.length);
    const pending = src.next();
    pending.catch(() => {});
    await tick();
    expect(src.pendingSince()).toBe(clock.t);
    expect(meter.pendingSince).toBe(clock.t);

    src.destroy(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    await tick();
    expect(fs.closes).toBe(0);
    expect(fs.openHandles.size).toBe(1);

    release();
    await src.closed;
    expect(fs.closes).toBe(1);
    expect(fs.openHandles.size).toBe(0);
  });

  it('destroys on abort and rejects the pending next()', async () => {
    const fs = new FakeFs(data);
    const controller = new AbortController();
    let release!: () => void;
    fs.onRead = () => new Promise<void>((resolve) => (release = resolve));
    const src = await FileSource.open('x', { fs, chunk: 1000, depth: 1, signal: controller.signal });
    src.setRange(0, data.length);
    const pending = src.next();
    pending.catch(() => {});
    await tick();
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
    release();
    await src.closed;
  });

  it('takes the readahead memory from the budget and returns it on close', async () => {
    const fs = new FakeFs(data);
    const memory = new ByteSemaphore(1_000_000);
    const src = await FileSource.open('x', { fs, chunk: 1000, depth: 4, memory });
    // 4 reads in flight or buffered, plus the chunk the consumer holds while the readahead refills
    expect(memory.held).toBe(5000);
    src.setRange(0, data.length);
    await readAll(src);
    src.destroy();
    await src.closed;
    expect(memory.held).toBe(0);
  });

  it('readAt retries like the sequential reads', async () => {
    const fs = new FakeFs(data);
    const clock = new FakeClock();
    let failed = false;
    fs.onRead = () => {
      if (failed) {
        return;
      }

      failed = true;
      throw errno('EAGAIN');
    };
    const src = await FileSource.open('x', { fs, clock, depth: 1 });
    expect(await src.readAt(9000, 1000)).toEqual(data.subarray(9000, 10_000));
    expect(src.meter.transportRetries).toBe(1);
    // readAt does not start the sequential readahead
    expect(fs.reads).toBe(2);
    src.destroy();
  });

  it('throttles to the requested rate', async () => {
    const fs = new FakeFs(randomBytesSeeded(3_000_000, 5));
    const clock = new FakeClock();
    const src = await FileSource.open('x', { fs, clock, chunk: 1_000_000, depth: 1, throttleMBps: 1 });
    src.setRange(0, 3_000_000);
    await readAll(src);
    // 3 MB at 1 MB/s: the second and third reads wait about a second each
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1900);
    src.destroy();
  });
});
