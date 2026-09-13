import { waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import SetPrivateAction from '$lib/components/timeline/actions/SetPrivateAction.svelte';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';

describe('SetPrivateAction component', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    assetMultiSelectManager.clear();
    privateModeManager.enabled = false;
    sdkMock.updateAssets.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    privateModeManager.enabled = false;
  });

  it('marks the selected non-private assets as private and keeps them while the mode is on', async () => {
    privateModeManager.enabled = true;
    const [privateAsset, plainAsset, otherPlainAsset] = [
      timelineAssetFactory.build({ isPrivate: true }),
      timelineAssetFactory.build({ isPrivate: false }),
      timelineAssetFactory.build({ isPrivate: false }),
    ];
    assetMultiSelectManager.selectAssets([privateAsset, plainAsset, otherPlainAsset]);
    const onSetPrivate = vi.fn();
    const onRemove = vi.fn();

    const sut = renderWithTooltips(SetPrivateAction, { onSetPrivate, onRemove });
    await userEvent.click(sut.getByRole('button', { name: 'Mark as private' }));

    await waitFor(() =>
      expect(sdkMock.updateAssets).toHaveBeenCalledExactlyOnceWith({
        assetBulkUpdateDto: { ids: [plainAsset.id, otherPlainAsset.id], isPrivate: true },
      }),
    );
    expect(plainAsset.isPrivate).toBe(true);
    expect(otherPlainAsset.isPrivate).toBe(true);
    expect(onSetPrivate).toHaveBeenCalledWith([plainAsset.id, otherPlainAsset.id], true);
    expect(onRemove).not.toHaveBeenCalled();
    expect(assetMultiSelectManager.selectionActive).toBe(false);
  });

  it('is available while the mode is off and removes the freshly marked assets from the view', async () => {
    const [plainAsset, otherPlainAsset] = timelineAssetFactory.buildList(2, { isPrivate: false });
    assetMultiSelectManager.selectAssets([plainAsset, otherPlainAsset]);
    const onSetPrivate = vi.fn();
    const onRemove = vi.fn();

    const sut = renderWithTooltips(SetPrivateAction, { onSetPrivate, onRemove });
    await userEvent.click(sut.getByRole('button', { name: 'Mark as private' }));

    await waitFor(() =>
      expect(sdkMock.updateAssets).toHaveBeenCalledExactlyOnceWith({
        assetBulkUpdateDto: { ids: [plainAsset.id, otherPlainAsset.id], isPrivate: true },
      }),
    );
    expect(onRemove).toHaveBeenCalledExactlyOnceWith([plainAsset.id, otherPlainAsset.id]);
    expect(onSetPrivate).not.toHaveBeenCalled();
    expect(assetMultiSelectManager.selectionActive).toBe(false);
  });

  it('removes private from the selected private assets when unmarking', async () => {
    privateModeManager.enabled = true;
    const privateAsset = timelineAssetFactory.build({ isPrivate: true });
    const plainAsset = timelineAssetFactory.build({ isPrivate: false });
    assetMultiSelectManager.selectAssets([privateAsset, plainAsset]);
    const onSetPrivate = vi.fn();

    const sut = renderWithTooltips(SetPrivateAction, { unmark: true, onSetPrivate });
    await userEvent.click(sut.getByRole('button', { name: 'Remove from private' }));

    await waitFor(() =>
      expect(sdkMock.updateAssets).toHaveBeenCalledExactlyOnceWith({
        assetBulkUpdateDto: { ids: [privateAsset.id], isPrivate: false },
      }),
    );
    expect(privateAsset.isPrivate).toBe(false);
    expect(onSetPrivate).toHaveBeenCalledWith([privateAsset.id], false);
  });

  it('skips the request when nothing needs to change', async () => {
    assetMultiSelectManager.selectAssets([timelineAssetFactory.build({ isPrivate: true })]);

    const sut = renderWithTooltips(SetPrivateAction, {});
    await userEvent.click(sut.getByRole('button', { name: 'Mark as private' }));

    await waitFor(() => expect(assetMultiSelectManager.selectionActive).toBe(false));
    expect(sdkMock.updateAssets).not.toHaveBeenCalled();
  });

  it('keeps the selection when the request fails', async () => {
    const plainAsset = timelineAssetFactory.build({ isPrivate: false });
    assetMultiSelectManager.selectAssets([plainAsset]);
    sdkMock.updateAssets.mockRejectedValue(new Error('private mode is off'));

    const sut = renderWithTooltips(SetPrivateAction, {});
    await userEvent.click(sut.getByRole('button', { name: 'Mark as private' }));

    await waitFor(() => expect(sdkMock.updateAssets).toHaveBeenCalledOnce());
    expect(plainAsset.isPrivate).toBe(false);
    expect(assetMultiSelectManager.selectionActive).toBe(true);
  });

  describe('as menu items', () => {
    it('offers both directions for a mixed selection while the mode is on', async () => {
      privateModeManager.enabled = true;
      const privateAsset = timelineAssetFactory.build({ isPrivate: true });
      const plainAsset = timelineAssetFactory.build({ isPrivate: false });
      assetMultiSelectManager.selectAssets([privateAsset, plainAsset]);
      const onSetPrivate = vi.fn();

      const sut = renderWithTooltips(SetPrivateAction, { menuItem: true, onSetPrivate });

      expect(sut.getByRole('menuitem', { name: 'Mark as private' })).toBeInTheDocument();
      expect(sut.getByRole('menuitem', { name: 'Remove from private' })).toBeInTheDocument();

      await userEvent.click(sut.getByRole('menuitem', { name: 'Remove from private' }));
      await waitFor(() =>
        expect(sdkMock.updateAssets).toHaveBeenCalledExactlyOnceWith({
          assetBulkUpdateDto: { ids: [privateAsset.id], isPrivate: false },
        }),
      );
      expect(onSetPrivate).toHaveBeenCalledWith([privateAsset.id], false);
    });

    it('removes the freshly marked assets through onRemove while the mode is off', async () => {
      const [plainAsset, otherPlainAsset] = timelineAssetFactory.buildList(2, { isPrivate: false });
      assetMultiSelectManager.selectAssets([plainAsset, otherPlainAsset]);
      const onSetPrivate = vi.fn();
      const onRemove = vi.fn();

      const sut = renderWithTooltips(SetPrivateAction, { menuItem: true, onSetPrivate, onRemove });
      await userEvent.click(sut.getByRole('menuitem', { name: 'Mark as private' }));

      await waitFor(() =>
        expect(sdkMock.updateAssets).toHaveBeenCalledExactlyOnceWith({
          assetBulkUpdateDto: { ids: [plainAsset.id, otherPlainAsset.id], isPrivate: true },
        }),
      );
      expect(onRemove).toHaveBeenCalledExactlyOnceWith([plainAsset.id, otherPlainAsset.id]);
      expect(onSetPrivate).not.toHaveBeenCalled();
      expect(assetMultiSelectManager.selectionActive).toBe(false);
    });

    it('only offers unmarking when every selected asset is private', () => {
      privateModeManager.enabled = true;
      assetMultiSelectManager.selectAssets(timelineAssetFactory.buildList(2, { isPrivate: true }));

      const sut = renderWithTooltips(SetPrivateAction, { menuItem: true });

      expect(sut.queryByRole('menuitem', { name: 'Mark as private' })).not.toBeInTheDocument();
      expect(sut.getByRole('menuitem', { name: 'Remove from private' })).toBeInTheDocument();
    });

    it('only offers marking while the mode is off', () => {
      assetMultiSelectManager.selectAssets([
        timelineAssetFactory.build({ isPrivate: true }),
        timelineAssetFactory.build({ isPrivate: false }),
      ]);

      const sut = renderWithTooltips(SetPrivateAction, { menuItem: true });

      expect(sut.getByRole('menuitem', { name: 'Mark as private' })).toBeInTheDocument();
      expect(sut.queryByRole('menuitem', { name: 'Remove from private' })).not.toBeInTheDocument();
    });
  });
});
