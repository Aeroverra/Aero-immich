import { toastManager, type ToastButton } from '@immich/ui';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { deleteAssets, UNDO_TOAST_TIMEOUT } from '$lib/utils/actions';
import { handleError } from '$lib/utils/handle-error';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';

vi.mock('@immich/ui', async (originalImport) => {
  const module = await originalImport<typeof import('@immich/ui')>();
  return {
    ...module,
    toastManager: {
      primary: vi.fn(),
      danger: vi.fn(),
      success: vi.fn(),
    },
  };
});

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

type ToastArgs = { description: string; button?: ToastButton | ((close: () => void) => ToastButton) };

const lastToast = () => {
  const [item, options] = vi.mocked(toastManager.primary).mock.calls.at(-1)!;
  return { item: item as ToastArgs, options };
};

/** clicks the toast's button the way @immich/ui does, returning whether the toast asked to close */
const clickUndo = async (item: ToastArgs) => {
  const close = vi.fn();
  const button = typeof item.button === 'function' ? item.button(close) : item.button;
  expect(button?.label).toEqual('Undo');
  await (button?.onclick as unknown as () => Promise<void> | void)();
  return close;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('deleteAssets', () => {
  beforeAll(async () => {
    register('en-US', () => import('$i18n/en.json'));
    await init({ fallbackLocale: 'en-US' });
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.deleteAssets.mockResolvedValue(undefined as never);
    sdkMock.restoreAssets.mockResolvedValue(undefined as never);
  });

  it('offers an undo for every trash, even when the view passes no undo handler', async () => {
    const assets = timelineAssetFactory.buildList(2);
    const onAssetDelete = vi.fn();

    await deleteAssets(false, onAssetDelete, assets);

    const ids = assets.map(({ id }) => id);
    expect(sdkMock.deleteAssets).toHaveBeenCalledExactlyOnceWith({ assetBulkDeleteDto: { ids, force: false } });
    expect(onAssetDelete).toHaveBeenCalledWith(ids);

    const { item, options } = lastToast();
    expect(item.description).toEqual('Trashed 2 assets');
    expect(options).toEqual({ timeout: UNDO_TOAST_TIMEOUT });

    const close = await clickUndo(item);
    await flush();

    expect(close).toHaveBeenCalledOnce();
    expect(sdkMock.restoreAssets).toHaveBeenCalledExactlyOnceWith({ bulkIdsDto: { ids } });
    expect(lastToast().item).toEqual('Restored 2 assets');
  });

  it('restores the stacked items too and hands the restored assets back to the view', async () => {
    const assets = [timelineAssetFactory.build({ isTrashed: false })];
    const onUndoDelete = vi.fn();
    const onRestore = vi.fn();
    const unsubscribe = eventManager.on({ AssetsRestore: onRestore });

    await deleteAssets(false, vi.fn(), assets, onUndoDelete, ['member-1', 'member-2']);
    await clickUndo(lastToast().item);
    await flush();
    unsubscribe();

    expect(sdkMock.restoreAssets).toHaveBeenCalledExactlyOnceWith({
      bulkIdsDto: { ids: [assets[0].id, 'member-1', 'member-2'] },
    });
    const restored = [{ ...assets[0], isTrashed: false }];
    expect(onRestore).toHaveBeenCalledExactlyOnceWith(restored);
    expect(onUndoDelete).toHaveBeenCalledExactlyOnceWith(restored);
    expect(lastToast().item).toEqual('Restored 3 assets');
  });

  it('has no undo for a permanent delete', async () => {
    await deleteAssets(true, vi.fn(), timelineAssetFactory.buildList(1), vi.fn());

    expect(sdkMock.deleteAssets).toHaveBeenCalledWith(
      expect.objectContaining({ assetBulkDeleteDto: expect.objectContaining({ force: true }) }),
    );
    const { item } = lastToast();
    expect(item.description).toEqual('Permanently deleted 1 asset');
    expect(item.button).toBeUndefined();
  });

  it('does not touch the trash when nobody clicks undo', async () => {
    await deleteAssets(false, vi.fn(), timelineAssetFactory.buildList(1), vi.fn());

    expect(lastToast().item.button).toBeDefined();
    expect(sdkMock.restoreAssets).not.toHaveBeenCalled();
  });

  it('reports a failed restore and leaves the view alone', async () => {
    sdkMock.restoreAssets.mockRejectedValue(new Error('nope'));
    const onUndoDelete = vi.fn();
    const onRestore = vi.fn();
    const unsubscribe = eventManager.on({ AssetsRestore: onRestore });

    await deleteAssets(false, vi.fn(), timelineAssetFactory.buildList(1), onUndoDelete);
    await clickUndo(lastToast().item);
    await flush();
    unsubscribe();

    expect(handleError).toHaveBeenCalledWith(expect.any(Error), 'Unable to restore assets');
    expect(onUndoDelete).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
  });
});
