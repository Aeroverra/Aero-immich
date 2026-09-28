import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
import { handleAlbumRemoteUpdate } from '$lib/services/album.service';
import { websocketEvents } from '$lib/stores/websocket';

type Handler = (...args: unknown[]) => void;
const handlers = vi.hoisted(() => new Map<string, Handler>());

vi.mock('socket.io-client', () => {
  const socket = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return socket;
    }),
    off: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  return { io: vi.fn(() => socket) };
});

vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/photos'), route: { id: '/(user)/photos' } },
}));

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));

vi.mock('$lib/services/album.service', () => ({
  handleAlbumRemoteUpdate: vi.fn().mockResolvedValue(undefined),
}));

describe('websocket store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(privateModeManager, 'invalidate').mockImplementation(() => {});
  });

  it('registers the private mode handlers', () => {
    expect(websocketEvents).toBeDefined();
    expect(handlers.has('on_asset_private_update')).toBe(true);
    expect(handlers.has('on_album_update')).toBe(true);
  });

  it('reloads the private-dependent state when the private flag spreads', () => {
    handlers.get('on_asset_private_update')!(['asset-1', 'asset-2']);

    expect(privateModeManager.invalidate).toHaveBeenCalledOnce();
  });

  it('reloads an album the server announced as changed', () => {
    handlers.get('on_album_update')!('album-1');

    expect(handleAlbumRemoteUpdate).toHaveBeenCalledExactlyOnceWith('album-1');
  });
});
