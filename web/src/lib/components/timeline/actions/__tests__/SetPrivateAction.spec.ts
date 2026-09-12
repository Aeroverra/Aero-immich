import { waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import SetPrivateAction from '$lib/components/timeline/actions/SetPrivateAction.svelte';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
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
    sdkMock.updateAssets.mockResolvedValue(undefined as never);
  });

  it('marks the selected non-private assets as private', async () => {
    const [privateAsset, plainAsset, otherPlainAsset] = [
      timelineAssetFactory.build({ isPrivate: true }),
      timelineAssetFactory.build({ isPrivate: false }),
      timelineAssetFactory.build({ isPrivate: false }),
    ];
    assetMultiSelectManager.selectAssets([privateAsset, plainAsset, otherPlainAsset]);
    const onSetPrivate = vi.fn();

    const sut = renderWithTooltips(SetPrivateAction, { onSetPrivate });
    await userEvent.click(sut.getByRole('button', { name: 'Mark as private' }));

    await waitFor(() =>
      expect(sdkMock.updateAssets).toHaveBeenCalledExactlyOnceWith({
        assetBulkUpdateDto: { ids: [plainAsset.id, otherPlainAsset.id], isPrivate: true },
      }),
    );
    expect(plainAsset.isPrivate).toBe(true);
    expect(otherPlainAsset.isPrivate).toBe(true);
    expect(onSetPrivate).toHaveBeenCalledWith([plainAsset.id, otherPlainAsset.id], true);
    expect(assetMultiSelectManager.selectionActive).toBe(false);
  });

  it('removes private from the selected private assets when unmarking', async () => {
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
});
