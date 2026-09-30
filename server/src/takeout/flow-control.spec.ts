import { Gate, ReadThrottle, ThrottleClock, allGates } from 'src/takeout/flow-control';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** A clock whose timers run only when the test advances it */
class ManualClock implements ThrottleClock {
  t = 0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private nextId = 1;

  now() {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }

  clearTimeout(id: unknown) {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  }

  /** advance to `ms` later, running the timers due on the way in order */
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      // the code waiting on earlier timers runs first and may set new ones
      await flush();
      this.timers.sort((a, b) => a.at - b.at);
      const due = this.timers[0];
      if (!due || due.at > end) {
        break;
      }
      this.timers.shift();
      this.t = due.at;
      due.fn();
    }
    this.t = end;
    await flush();
  }
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('Gate', () => {
  it('lets waiters through when it opens, and tells how long it was closed', async () => {
    const gate = new Gate();
    expect(gate.isOpen).toBe(true);
    await gate.wait();

    expect(gate.close(1000)).toBe(true);
    expect(gate.close(1500)).toBe(false);
    let passed = false;
    const waiting = gate.wait().then(() => (passed = true));
    await flush();
    expect(passed).toBe(false);

    expect(gate.open(4000)).toBe(3000);
    await waiting;
    expect(passed).toBe(true);
    expect(gate.openedAt).toBe(4000);
    expect(gate.open(5000)).toBe(0);
  });

  it('rejects a waiter whose signal aborts, and reports every change', async () => {
    const gate = new Gate();
    const changes: Array<{ open: boolean; closedMs: number }> = [];
    gate.onChange((change) => {
      changes.push(change);
    });
    gate.close(0);
    const controller = new AbortController();
    const waiting = gate.wait(controller.signal);
    controller.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
    gate.open(10);
    expect(changes).toEqual([
      { open: false, closedMs: 0 },
      { open: true, closedMs: 10 },
    ]);
  });

  it('allGates waits until every gate is open at the same time', async () => {
    const a = new Gate();
    const b = new Gate();
    a.close();
    b.close();
    let passed = false;
    const waiting = allGates(a, b, null)
      .wait()
      .then(() => (passed = true));
    a.open();
    await flush();
    expect(passed).toBe(false);
    // a closes again before b opens: still waiting
    a.close();
    b.open();
    await flush();
    expect(passed).toBe(false);
    a.open();
    await waiting;
    expect(passed).toBe(true);
  });
});

/** takes `count` reads of `bytes` one after the other; returns the clock time each one was let through */
function reader(throttle: ReadThrottle, clock: ManualClock, bytes: number, count: number) {
  const times: number[] = [];
  const done = (async () => {
    for (let i = 0; i < count; i++) {
      await throttle.take(bytes);
      times.push(clock.now());
    }
  })();
  return { times, done };
}

describe('ReadThrottle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets reads through at the rate', async () => {
    const clock = new ManualClock();
    const throttle = new ReadThrottle(1, clock);
    const { times, done } = reader(throttle, clock, 250_000, 5);
    await clock.advance(2000);
    await done;
    // the first read passes at once, each next one after the debt of the previous is paid back (250 ms)
    expect(times).toEqual([0, 250, 500, 750, 1000]);
    expect(throttle.passed).toBe(1_250_000);
  });

  it('applies a new rate to the reads already waiting', async () => {
    const clock = new ManualClock();
    const throttle = new ReadThrottle(1, clock);
    const { times, done } = reader(throttle, clock, 500_000, 6);
    await clock.advance(1000);
    expect(times).toEqual([0, 500, 1000]);
    // raised: the waiting read is served after its debt at the new rate (125 ms), not the old one (500 ms)
    throttle.setRate(4);
    await clock.advance(1000);
    expect(times).toEqual([0, 500, 1000, 1125, 1250, 1375]);
    await done;

    // lowered while a read waits: the time already waited counts at the old rate, the rest at the new one
    const lowered = new ReadThrottle(4, clock);
    const start = clock.now();
    const slow = reader(lowered, clock, 1_000_000, 2);
    await clock.advance(100);
    lowered.setRate(1);
    await clock.advance(2000);
    await slow.done;
    expect(slow.times.map((t) => t - start)).toEqual([0, 700]);
  });

  it('lets every waiting read through when the limit is removed', async () => {
    const clock = new ManualClock();
    const throttle = new ReadThrottle(0.001, clock);
    const { times, done } = reader(throttle, clock, 1_000_000, 3);
    await flush();
    expect(times).toEqual([0]);
    throttle.setRate(null);
    await done;
    expect(times).toEqual([0, 0, 0]);
    expect(throttle.rateMBps).toBeNull();
  });

  it('drops a waiting read whose signal aborts', async () => {
    const clock = new ManualClock();
    const throttle = new ReadThrottle(1, clock);
    await throttle.take(1_000_000);
    const controller = new AbortController();
    const waiting = throttle.take(1000, controller.signal);
    expect(throttle.waiting).toBe(1);
    controller.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
    expect(throttle.waiting).toBe(0);
  });

  it('measures the new rate after a live change (real timers)', async () => {
    vi.useFakeTimers();
    const throttle = new ReadThrottle(2);
    let bytes = 0;
    let stop = false;
    const loop = (async () => {
      while (!stop) {
        await throttle.take(100_000);
        bytes += 100_000;
      }
    })();
    await vi.advanceTimersByTimeAsync(1000);
    const first = bytes;
    throttle.setRate(8);
    await vi.advanceTimersByTimeAsync(1000);
    const second = bytes - first;
    stop = true;
    await vi.advanceTimersByTimeAsync(100);
    await loop;
    // about 2 MB in the first second, about 8 MB in the next
    expect(first).toBeGreaterThanOrEqual(1_900_000);
    expect(first).toBeLessThanOrEqual(2_700_000);
    expect(second).toBeGreaterThanOrEqual(7_500_000);
    expect(second).toBeLessThanOrEqual(8_700_000);
  });
});
