import { ByteSemaphore } from 'src/takeout/byte-semaphore';
import { describe, expect, it } from 'vitest';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe(ByteSemaphore.name, () => {
  it('admits requests that fit and queues the rest', async () => {
    const sem = new ByteSemaphore(100);
    const a = await sem.acquire(60);
    let admitted = false;
    const pending = sem.acquire(50).then((lease) => {
      admitted = true;
      return lease;
    });
    await tick();
    expect(admitted).toBe(false);
    a.release();
    const b = await pending;
    expect(admitted).toBe(true);
    expect(sem.held).toBe(50);
    b.release();
    expect(sem.held).toBe(0);
  });

  it('is FIFO: a large request is not starved by small ones', async () => {
    const sem = new ByteSemaphore(100);
    const first = await sem.acquire(90);
    const order: string[] = [];
    const large = sem.acquire(80).then((lease) => {
      order.push('large');
      return lease;
    });
    // small requests that would fit now wait behind the large one
    const small1 = sem.acquire(5).then((lease) => {
      order.push('small1');
      return lease;
    });
    const small2 = sem.acquire(5).then((lease) => {
      order.push('small2');
      return lease;
    });
    await tick();
    expect(order).toEqual([]);
    first.release();
    const l = await large;
    await tick();
    expect(order).toEqual(['large', 'small1', 'small2']);
    l.release();
    const s1 = await small1;
    const s2 = await small2;
    s1.release();
    s2.release();
    expect(sem.held).toBe(0);
  });

  it('admits a request above the whole budget when nothing else is held', async () => {
    const sem = new ByteSemaphore(100);
    const held = await sem.acquire(10);
    let admitted = false;
    const huge = sem.acquire(1000).then((lease) => {
      admitted = true;
      return lease;
    });
    await tick();
    expect(admitted).toBe(false);
    held.release();
    const lease = await huge;
    expect(admitted).toBe(true);
    expect(sem.held).toBe(1000);
    lease.release();
    expect(sem.held).toBe(0);
  });

  it('frees shared leases on the last release only', async () => {
    const sem = new ByteSemaphore(100);
    const lease = await sem.acquire(40);
    const shareA = lease.share();
    const shareB = shareA.share();
    lease.release();
    lease.release(); // idempotent per handle
    expect(sem.held).toBe(40);
    shareA.release();
    expect(sem.held).toBe(40);
    shareB.release();
    expect(sem.held).toBe(0);
  });

  it('rejects a waiting request on abort and admits the next one', async () => {
    const sem = new ByteSemaphore(100);
    const held = await sem.acquire(100);
    const controller = new AbortController();
    const aborted = sem.acquire(50, controller.signal);
    const next = sem.acquire(10);
    controller.abort(new Error('stop'));
    await expect(aborted).rejects.toThrow('stop');
    held.release();
    const lease = await next;
    expect(sem.held).toBe(10);
    lease.release();
  });

  it('rejects at once when the signal is already aborted', async () => {
    const sem = new ByteSemaphore(100);
    await expect(sem.acquire(1, AbortSignal.abort(new Error('gone')))).rejects.toThrow('gone');
  });

  it('tryAcquire only succeeds when nothing waits and the bytes fit', () => {
    const sem = new ByteSemaphore(100);
    const a = sem.tryAcquire(70)!;
    expect(a).not.toBeNull();
    expect(sem.tryAcquire(40)).toBeNull();
    a.release();
    expect(sem.tryAcquire(40)).not.toBeNull();
    expect(sem.peak).toBe(70);
  });
});
