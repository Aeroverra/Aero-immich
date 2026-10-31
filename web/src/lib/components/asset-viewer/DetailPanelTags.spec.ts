import { StackSource, type StackResponseDto, type TagResponseDto } from '@immich/sdk';
import { screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import DetailPanelTags from '$lib/components/asset-viewer/DetailPanelTags.svelte';
import { tagPicker, tagPickerSearch } from '$lib/components/tags/tag-picker.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

const newTag = (value: string): TagResponseDto => ({
  id: value,
  value,
  name: value.split('/').at(-1)!,
  isHidden: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('DetailPanelTags', () => {
  const user = userAdminFactory.build();
  const cake = newTag('Food/Dessert/Cake');
  const allTags = [newTag('Food'), newTag('Food/Dessert'), cake, newTag('Food/Drinks'), newTag('Trip')];
  // a Video Boost pair: a manual stack the user handles as one item
  const video = assetFactory.build({
    id: 'video',
    ownerId: user.id,
    tags: [cake],
    stack: { id: 'stack-1', primaryAssetId: 'video', assetCount: 2 },
  });
  const boosted = assetFactory.build({ id: 'boosted', ownerId: user.id });
  const stack: StackResponseDto = {
    id: 'stack-1',
    primaryAssetId: 'video',
    source: StackSource.Manual,
    assets: [video, boosted],
  };

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    authManager.setUser(user);
    tagPicker.isOpen.current = false;
    tagPicker.expanded.current = [];
    tagPicker.recent.current = [];
    tagPickerSearch.query = '';
    sdkMock.getStack.mockResolvedValue(stack);
    sdkMock.getAllTags.mockResolvedValue(allTags);
    sdkMock.getAssetInfo.mockResolvedValue(video);
    sdkMock.untagAssets.mockResolvedValue([]);
    sdkMock.bulkTagAssets.mockResolvedValue({ count: 2 });
  });

  afterEach(() => {
    authManager.reset();
  });

  it('shows tags under their parent path with short names', () => {
    renderWithTooltips(DetailPanelTags, { asset: video, isOwner: true });

    expect(screen.getByText('Food › Dessert')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cake' })).toHaveAttribute('title', 'Food/Dessert/Cake');
  });

  it('shows a tag in its own color', () => {
    const colored = { ...newTag('Trip'), color: '#ff0000' };
    renderWithTooltips(DetailPanelTags, { asset: { ...video, tags: [cake, colored] }, isOwner: true });

    const chip = (name: string) =>
      screen.getAllByTestId('tag-chip').find((element) => element.textContent?.includes(name))!;
    const plain = chip('Cake');
    const red = chip('Trip');
    expect(plain.style.backgroundColor).toBe('');
    expect(red.style.backgroundColor).toBe('#ff0000');
    expect(red.style.color).toBe('#000000');
  });

  it('shows only the picker while editing and the tag list again when done', async () => {
    renderWithTooltips(DetailPanelTags, { asset: video, isOwner: true });

    await userEvent.click(screen.getByTestId('detail-panel-tags-toggle'));

    expect(await screen.findByLabelText('Search or create tags')).toBeInTheDocument();
    expect(screen.queryByTestId('detail-panel-tags')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove tag' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('detail-panel-tags-toggle'));

    expect(screen.getByRole('link', { name: 'Cake' })).toBeInTheDocument();
    expect(screen.queryByTestId('tag-tree-picker')).not.toBeInTheDocument();
  });

  it('removes a tag from the whole manual stack', async () => {
    renderWithTooltips(DetailPanelTags, { asset: video, isOwner: true });

    await userEvent.click(screen.getByRole('button', { name: 'Remove tag' }));

    await waitFor(() =>
      expect(sdkMock.untagAssets).toHaveBeenCalledWith({ id: cake.id, bulkIdsDto: { ids: ['video', 'boosted'] } }),
    );
  });

  it('tags the whole stack from the tree and keeps the tree as it was on the next asset', async () => {
    const { rerender } = renderWithTooltips(DetailPanelTags, { asset: video, isOwner: true });

    await userEvent.click(screen.getByTestId('detail-panel-tags-toggle'));
    await userEvent.click(await screen.findByRole('button', { name: 'Expand' }));
    expect(screen.getByRole('treeitem', { name: /Drinks/ })).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Drinks'));
    await waitFor(() =>
      expect(sdkMock.bulkTagAssets).toHaveBeenCalledWith({
        tagBulkAssetsDto: { tagIds: ['Food/Drinks'], assetIds: ['video', 'boosted'] },
      }),
    );
    expect(tagPicker.recent.current).toEqual(['Food/Drinks']);

    const next = assetFactory.build({ id: 'next', ownerId: user.id, tags: [] });
    await rerender({ component: DetailPanelTags, componentProps: { asset: next, isOwner: true } } as never);

    expect(screen.getByTestId('tag-tree-picker')).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /Drinks/ })).toBeInTheDocument();
    expect(tagPicker.expanded.current).toEqual(['Food']);
  });

  it('gives the viewer the new tags, so going back to the asset shows them', async () => {
    const emit = vi.spyOn(eventManager, 'emit');
    const untagged = { ...video, tags: [] };
    sdkMock.getAssetInfo.mockResolvedValue(untagged);
    renderWithTooltips(DetailPanelTags, { asset: video, isOwner: true });

    await userEvent.click(screen.getByRole('button', { name: 'Remove tag' }));

    await waitFor(() => expect(emit).toHaveBeenCalledWith('AssetUpdate', untagged));
    expect(emit).toHaveBeenCalledWith('AssetsTag', ['boosted']);
  });

  it('keeps the search when the viewer closes and opens another asset', async () => {
    tagPicker.isOpen.current = true;
    const { unmount } = renderWithTooltips(DetailPanelTags, { asset: video, isOwner: true });
    await userEvent.type(await screen.findByLabelText('Search or create tags'), 'dri');
    unmount();

    renderWithTooltips(DetailPanelTags, { asset: boosted, isOwner: true });

    expect(await screen.findByLabelText('Search or create tags')).toHaveValue('dri');
    expect(screen.getByRole('treeitem', { name: /Drinks/ })).toBeInTheDocument();
  });

  it('applies the best match on Enter and creates a missing path', async () => {
    tagPicker.isOpen.current = true;
    sdkMock.upsertTags.mockResolvedValue([newTag('Trip/Beach')]);
    renderWithTooltips(DetailPanelTags, { asset: video, isOwner: true });
    const search = await screen.findByLabelText('Search or create tags');

    await userEvent.type(search, 'drinks{Enter}');
    await waitFor(() =>
      expect(sdkMock.bulkTagAssets).toHaveBeenCalledWith({
        tagBulkAssetsDto: { tagIds: ['Food/Drinks'], assetIds: ['video', 'boosted'] },
      }),
    );
    expect(search).toHaveValue('');

    await userEvent.type(search, 'Trip / Beach{Enter}');
    await waitFor(() => expect(sdkMock.upsertTags).toHaveBeenCalledWith({ tagUpsertDto: { tags: ['Trip/Beach'] } }));
    await waitFor(() =>
      expect(sdkMock.bulkTagAssets).toHaveBeenCalledWith({
        tagBulkAssetsDto: { tagIds: ['Trip/Beach'], assetIds: ['video', 'boosted'] },
      }),
    );
  });
});
