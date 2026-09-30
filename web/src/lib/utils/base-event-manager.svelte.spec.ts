import { BaseEventManager } from '$lib/utils/base-event-manager.svelte';

type Events = { Ping: [number] };

describe('BaseEventManager', () => {
  it('keeps subscriptions added after an earlier one when that earlier one is removed', () => {
    const manager = new BaseEventManager<Events>();
    const first = vi.fn();
    const second = vi.fn();
    const off = manager.on({ Ping: first });
    manager.on({ Ping: second });

    off();
    manager.emit('Ping', 1);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith(1);
    expect(manager.hasListeners('Ping')).toBe(true);
  });

  it('removes only its own subscription, even when cleanup runs twice', () => {
    const manager = new BaseEventManager<Events>();
    const first = vi.fn();
    const second = vi.fn();
    const off = manager.on({ Ping: first });
    manager.on({ Ping: second });

    off();
    off();
    manager.emit('Ping', 2);

    expect(second).toHaveBeenCalledOnce();
  });
});
