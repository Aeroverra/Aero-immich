import { waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import SetPrivateAction from '$lib/components/asset-viewer/actions/SetPrivateAction.svelte';
import { AssetAction } from '$lib/constants';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
import { toTimelineAsset } from '$lib/utils/timeline-util';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';

describe('asset viewer SetPrivateAction component', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    privateModeManager.enabled = false;
  });

  afterEach(() => {
    privateModeManager.enabled = false;
  });

  it('is available while the mode is off and moves the viewer along before the asset disappears', async () => {
    const asset = assetFactory.build({ isPrivate: false });
    // the component flips asset.isPrivate on success, so snapshot the pre-action payload first
    const beforeUpdate = toTimelineAsset(asset);
    const updated = { ...asset, isPrivate: true };
    sdkMock.updateAsset.mockResolvedValue(updated);
    const onAction = vi.fn();
    const preAction = vi.fn();
    const onAssetUpdate = vi.fn();
    const unsubscribe = eventManager.on({ AssetUpdate: onAssetUpdate });

    const sut = renderWithTooltips(SetPrivateAction, { asset, onAction, preAction });
    await userEvent.click(sut.getByRole('menuitem', { name: 'Mark as private' }));

    await waitFor(() =>
      expect(sdkMock.updateAsset).toHaveBeenCalledExactlyOnceWith({
        id: asset.id,
        updateAssetDto: { isPrivate: true },
      }),
    );
    // same pre-action flow as moving an asset to the locked folder: leave the asset before the request
    expect(preAction).toHaveBeenCalledExactlyOnceWith({ type: AssetAction.SET_PRIVATE, asset: beforeUpdate });
    expect(onAction).toHaveBeenCalledExactlyOnceWith({
      type: AssetAction.SET_PRIVATE,
      asset: toTimelineAsset(updated),
    });
    expect(onAssetUpdate).toHaveBeenCalledWith(updated);
    unsubscribe();
  });

  it('keeps the viewer on the asset while the mode is on', async () => {
    privateModeManager.enabled = true;
    const asset = assetFactory.build({ isPrivate: false });
    sdkMock.updateAsset.mockResolvedValue({ ...asset, isPrivate: true });
    const onAction = vi.fn();
    const preAction = vi.fn();

    const sut = renderWithTooltips(SetPrivateAction, { asset, onAction, preAction });
    await userEvent.click(sut.getByRole('menuitem', { name: 'Mark as private' }));

    await waitFor(() => expect(onAction).toHaveBeenCalledOnce());
    expect(preAction).not.toHaveBeenCalled();
  });

  it('unmarks a private asset without a pre-action', async () => {
    privateModeManager.enabled = true;
    const asset = assetFactory.build({ isPrivate: true });
    sdkMock.updateAsset.mockResolvedValue({ ...asset, isPrivate: false });
    const onAction = vi.fn();
    const preAction = vi.fn();

    const sut = renderWithTooltips(SetPrivateAction, { asset, onAction, preAction });
    await userEvent.click(sut.getByRole('menuitem', { name: 'Remove from private' }));

    await waitFor(() =>
      expect(sdkMock.updateAsset).toHaveBeenCalledExactlyOnceWith({
        id: asset.id,
        updateAssetDto: { isPrivate: false },
      }),
    );
    expect(preAction).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: AssetAction.UNSET_PRIVATE }));
  });
});
