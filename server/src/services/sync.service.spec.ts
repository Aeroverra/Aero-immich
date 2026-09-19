import { Writable } from 'node:stream';
import { SyncEntityType } from 'src/enum';
import { AlbumViewStateRow } from 'src/repositories/sync.repository';
import { send, toAlbumViewStateChanges } from 'src/services/sync.service';
import { ClientDisconnectedError } from 'src/utils/response';
import { serialize } from 'src/utils/sync';

type TestStream = {
  stream: Writable;
  chunks: string[];
  flushNext: () => void;
  pendingCount: () => number;
};

const createTestStream = (highWaterMark: number): TestStream => {
  const chunks: string[] = [];
  const pendingCallbacks: Array<() => void> = [];

  const stream = new Writable({
    highWaterMark,
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      pendingCallbacks.push(callback);
    },
  });

  return {
    stream,
    chunks,
    flushNext: () => pendingCallbacks.shift()?.(),
    pendingCount: () => pendingCallbacks.length,
  };
};

describe('send', () => {
  const item = {
    type: SyncEntityType.SyncCompleteV1 as const,
    data: {},
    ids: ['now-id'] as [string],
  };

  it('should resolve immediately when the stream has capacity', async () => {
    // A large highWaterMark means write() never signals backpressure for a
    // single small item.
    const { stream, chunks, flushNext } = createTestStream(1024 * 1024);

    const sendPromise = send(stream, item);
    flushNext();
    await sendPromise;

    expect(chunks).toEqual([serialize(item)]);
  });

  it('should wait for the drain event when the stream signals backpressure', async () => {
    // A tiny highWaterMark means the very first write already exceeds
    // capacity, so write() returns false and send() must wait for 'drain'.
    const { stream, chunks, flushNext, pendingCount } = createTestStream(1);

    let resolved = false;
    const sendPromise = send(stream, item).then(() => {
      resolved = true;
    });

    // Let any pending microtasks run; send() should still be waiting on the
    // underlying write to complete and 'drain' to fire — it must not resolve
    // just because write() was called.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(pendingCount()).toBe(1);

    // Completing the write lets the stream's internal buffer drop back below
    // highWaterMark, which is what triggers the 'drain' event.
    flushNext();
    await sendPromise;

    expect(resolved).toBe(true);
    expect(chunks).toEqual([serialize(item)]);
  });

  it('should throw a disconnect error when the stream destroyed', async () => {
    const { stream, chunks } = createTestStream(1024 * 1024);

    stream.destroy();

    await expect(send(stream, item)).rejects.toBeInstanceOf(ClientDisconnectedError);
    expect(chunks).toEqual([]);
  });

  it('should throw a disconnect error when the stream is destroyed after writing some data', async () => {
    const { stream } = createTestStream(1);

    const sendPromise = send(stream, item);

    await Promise.resolve();
    stream.destroy();

    await expect(sendPromise).rejects.toBeInstanceOf(ClientDisconnectedError);
  });

  it('should handle a stream error', async () => {
    const { stream } = createTestStream(1);
    const error = new Error('socket hang up');

    const sendPromise = send(stream, item);

    await Promise.resolve();
    stream.emit('error', error);

    await expect(sendPromise).rejects.toBe(error);
  });
});

const row = (overrides: Partial<AlbumViewStateRow> = {}): AlbumViewStateRow => ({
  albumId: 'album',
  albumThumbnailAssetId: 'cover',
  hasAssets: true,
  hasVisibleAssets: true,
  visibleThumbnailAssetId: 'cover',
  stateAlbumId: null,
  stateIsHidden: null,
  stateThumbnailAssetId: null,
  ...overrides,
});

describe(toAlbumViewStateChanges.name, () => {
  it('should change nothing for an album the view shows with its own cover', () => {
    expect(toAlbumViewStateChanges([row()])).toEqual({ upserts: [], deletes: [], touched: [], shown: [] });
  });

  it('should keep an album without assets visible', () => {
    const empty = row({
      albumThumbnailAssetId: null,
      hasAssets: false,
      hasVisibleAssets: false,
      visibleThumbnailAssetId: null,
    });
    expect(toAlbumViewStateChanges([empty])).toEqual({ upserts: [], deletes: [], touched: [], shown: [] });
  });

  it('should hide an album whose assets the view all hides', () => {
    expect(toAlbumViewStateChanges([row({ hasVisibleAssets: false, visibleThumbnailAssetId: null })])).toEqual({
      upserts: [{ albumId: 'album', isHidden: true, thumbnailAssetId: null }],
      deletes: [],
      touched: ['album'],
      shown: [],
    });
  });

  it('should not send a hidden album again while it stays hidden', () => {
    const hidden = row({
      hasVisibleAssets: false,
      visibleThumbnailAssetId: null,
      stateAlbumId: 'album',
      stateIsHidden: true,
    });
    expect(toAlbumViewStateChanges([hidden])).toEqual({ upserts: [], deletes: [], touched: [], shown: [] });
  });

  it('should show a hidden album again with its links', () => {
    expect(toAlbumViewStateChanges([row({ stateAlbumId: 'album', stateIsHidden: true })])).toEqual({
      upserts: [],
      deletes: ['album'],
      touched: ['album'],
      shown: ['album'],
    });
  });

  it('should replace a hidden cover and send the album once', () => {
    const replaced = row({ visibleThumbnailAssetId: 'newest' });
    expect(toAlbumViewStateChanges([replaced])).toEqual({
      upserts: [{ albumId: 'album', isHidden: false, thumbnailAssetId: 'newest' }],
      deletes: [],
      touched: ['album'],
      shown: [],
    });

    const unchanged = row({
      visibleThumbnailAssetId: 'newest',
      stateAlbumId: 'album',
      stateIsHidden: false,
      stateThumbnailAssetId: 'newest',
    });
    expect(toAlbumViewStateChanges([unchanged])).toEqual({ upserts: [], deletes: [], touched: [], shown: [] });
  });

  it('should send the album cover again once the view shows it', () => {
    const restored = row({ stateAlbumId: 'album', stateIsHidden: false, stateThumbnailAssetId: 'newest' });
    expect(toAlbumViewStateChanges([restored])).toEqual({
      upserts: [],
      deletes: ['album'],
      touched: ['album'],
      shown: [],
    });
  });
});
