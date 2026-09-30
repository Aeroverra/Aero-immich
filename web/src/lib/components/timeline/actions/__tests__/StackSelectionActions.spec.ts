import { StackActionMode, StackSource, type StackResponseDto } from '@immich/sdk';
import { modalManager, toastManager } from '@immich/ui';
import { waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
import FavoriteAction from '$lib/components/timeline/actions/FavoriteAction.svelte';
import TagAction from '$lib/components/timeline/actions/TagAction.svelte';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import AssetTagModal from '$lib/modals/AssetTagModal.svelte';
import StackSelectionModal from '$lib/modals/StackSelectionModal.svelte';
import { deleteAssets } from '$lib/utils/actions';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory, timelineAssetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('@immich/ui', async (originalImport) => {
  const module = await originalImport<typeof import('@immich/ui')>();
  return {
    ...module,
    modalManager: {
      show: vi.fn(),
      showDialog: vi.fn(),
    },
    toastManager: {
      primary: vi.fn(),
      danger: vi.fn(),
      success: vi.fn(),
    },
  };
});

describe('actions on a selection with stacks', () => {
  const user = userAdminFactory.build();
  const stack: StackResponseDto = {
    id: 'stack-1',
    primaryAssetId: 'primary',
    source: StackSource.Manual,
    assets: ['primary', 'member-1', 'member-2'].map((id) => assetFactory.build({ id, ownerId: user.id })),
  };
  const buildSelection = () => [
    timelineAssetFactory.build({
      id: 'primary',
      ownerId: user.id,
      isFavorite: false,
      stack: { id: 'stack-1', primaryAssetId: 'primary', assetCount: 3 },
    }),
    timelineAssetFactory.build({ id: 'plain', ownerId: user.id, isFavorite: false }),
  ];

  const chooseInDialog = (includeStacked: boolean) => {
    vi.mocked(modalManager.show).mockImplementation((...args) =>
      Promise.resolve((args[0] === StackSelectionModal ? { includeStacked, remember: false } : true) as never),
    );
  };

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    assetMultiSelectManager.clear();
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ stackActions: { mode: StackActionMode.Ask } }));
    sdkMock.getStack.mockResolvedValue(stack);
    sdkMock.updateAssets.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    authManager.reset();
  });

  it('favorites only the top items when asked to', async () => {
    chooseInDialog(false);
    assetMultiSelectManager.selectAssets(buildSelection());

    const sut = renderWithTooltips(FavoriteAction, { removeFavorite: false });
    await userEvent.click(sut.getByRole('button', { name: 'Favorite' }));

    await waitFor(() =>
      expect(sdkMock.updateAssets).toHaveBeenCalledExactlyOnceWith({
        assetBulkUpdateDto: { ids: ['primary', 'plain'], isFavorite: true },
      }),
    );
    expect(modalManager.show).toHaveBeenCalledWith(StackSelectionModal, { stackCount: 1 });
  });

  it('favorites the stacked items too when asked to', async () => {
    chooseInDialog(true);
    const onFavorite = vi.fn();
    assetMultiSelectManager.selectAssets(buildSelection());

    const sut = renderWithTooltips(FavoriteAction, { removeFavorite: false, onFavorite });
    await userEvent.click(sut.getByRole('button', { name: 'Favorite' }));

    await waitFor(() =>
      expect(sdkMock.updateAssets).toHaveBeenCalledExactlyOnceWith({
        assetBulkUpdateDto: { ids: ['primary', 'plain', 'member-1', 'member-2'], isFavorite: true },
      }),
    );
    expect(onFavorite).toHaveBeenCalledWith(['primary', 'plain', 'member-1', 'member-2'], true);
    expect(toastManager.primary).toHaveBeenCalled();
  });

  it('does nothing when the dialog is closed', async () => {
    vi.mocked(modalManager.show).mockResolvedValue(undefined as never);
    assetMultiSelectManager.selectAssets(buildSelection());

    const sut = renderWithTooltips(FavoriteAction, { removeFavorite: false });
    await userEvent.click(sut.getByRole('button', { name: 'Favorite' }));

    await waitFor(() => expect(modalManager.show).toHaveBeenCalledOnce());
    expect(sdkMock.updateAssets).not.toHaveBeenCalled();
    expect(assetMultiSelectManager.selectionActive).toBe(true);
  });

  it('tags the stacked items with a remembered choice without asking', async () => {
    authManager.setPreferences(preferencesFactory.build({ stackActions: { mode: StackActionMode.Stack } }));
    vi.mocked(modalManager.show).mockResolvedValue(false as never);
    assetMultiSelectManager.selectAssets(buildSelection());

    const sut = renderWithTooltips(TagAction, {});
    await userEvent.click(sut.getByRole('button', { name: 'Tag' }));

    await waitFor(() =>
      expect(modalManager.show).toHaveBeenCalledExactlyOnceWith(AssetTagModal, {
        assetIds: ['primary', 'plain', 'member-1', 'member-2'],
      }),
    );
  });

  it('does not ask for a selection without stacks', async () => {
    vi.mocked(modalManager.show).mockResolvedValue(false as never);
    assetMultiSelectManager.selectAssets([timelineAssetFactory.build({ id: 'plain', ownerId: user.id })]);

    const sut = renderWithTooltips(TagAction, {});
    await userEvent.click(sut.getByRole('button', { name: 'Tag' }));

    await waitFor(() =>
      expect(modalManager.show).toHaveBeenCalledExactlyOnceWith(AssetTagModal, { assetIds: ['plain'] }),
    );
    expect(sdkMock.getStack).not.toHaveBeenCalled();
  });

  it('downloads a single stack with its stacked items as an archive', async () => {
    chooseInDialog(true);
    sdkMock.getDownloadInfo.mockResolvedValue({ totalSize: 0, archives: [] });
    assetMultiSelectManager.selectAssets([buildSelection()[0]]);

    const sut = renderWithTooltips(DownloadAction, {});
    await userEvent.click(sut.getByRole('button', { name: 'Download' }));

    await waitFor(() =>
      expect(sdkMock.getDownloadInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          downloadInfoDto: expect.objectContaining({ assetIds: ['primary', 'member-1', 'member-2'] }),
        }),
      ),
    );
    expect(sdkMock.getAssetInfo).not.toHaveBeenCalled();
  });

  it('trashes and restores the stacked items along with the selection', async () => {
    sdkMock.deleteAssets.mockResolvedValue(undefined as never);
    sdkMock.restoreAssets.mockResolvedValue(undefined as never);
    const selection = buildSelection();
    const onAssetDelete = vi.fn();
    const onUndoDelete = vi.fn();

    await deleteAssets(false, onAssetDelete, selection, onUndoDelete, ['member-1', 'member-2']);

    const ids = ['primary', 'plain', 'member-1', 'member-2'];
    expect(sdkMock.deleteAssets).toHaveBeenCalledExactlyOnceWith({ assetBulkDeleteDto: { ids, force: false } });
    expect(onAssetDelete).toHaveBeenCalledWith(ids);

    const toast = vi.mocked(toastManager.primary).mock.calls[0][0] as { button: { onclick: () => Promise<void> } };
    await toast.button.onclick();

    expect(sdkMock.restoreAssets).toHaveBeenCalledExactlyOnceWith({ bulkIdsDto: { ids } });
    expect(onUndoDelete).toHaveBeenCalledWith(selection);
  });
});
