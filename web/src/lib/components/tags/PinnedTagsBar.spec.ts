import { StackActionMode, type TagResponseDto } from '@immich/sdk';
import { screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import PinnedTagsBar from '$lib/components/tags/PinnedTagsBar.svelte';
import { tagPicker } from '$lib/components/tags/tag-picker.svelte';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

const newTag = (value: string): TagResponseDto => ({
  id: value,
  value,
  name: value.split('/').at(-1)!,
  isHidden: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('PinnedTagsBar', () => {
  const user = userAdminFactory.build();
  const select = (...ids: string[]) =>
    assetMultiSelectManager.selectAssets(ids.map((id) => timelineAssetFactory.build({ id, ownerId: user.id })));
  const chip = (value: string) =>
    screen.getAllByTestId('pinned-tag').find((element) => element.dataset.tagValue === value)!;
  const chipButton = (value: string) => chip(value).querySelector('button')!;

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
    tagPicker.recent.current = [];
    tagPicker.pinned.current = ['Food/Dessert/Cake', 'Food/Fruit', 'Travel', 'deleted'];
    sdkMock.getAllTags.mockResolvedValue([
      newTag('Food'),
      newTag('Food/Dessert'),
      newTag('Food/Dessert/Cake'),
      newTag('Food/Fruit'),
      newTag('Travel'),
    ]);
    // of the assets a, b and c: all carry Cake, one carries Fruit, none carries Travel
    sdkMock.getTagAssetCounts.mockResolvedValue([
      { tagId: 'Food/Dessert/Cake', count: 3 },
      { tagId: 'Food/Fruit', count: 1 },
    ]);
    sdkMock.bulkTagAssets.mockResolvedValue({ count: 3 });
    sdkMock.untagAssets.mockResolvedValue([]);
  });

  it('shows the pinned tags by name with whether all, some or none of the selection carry them', async () => {
    select('a', 'b', 'c');
    renderWithTooltips(PinnedTagsBar, {});

    await waitFor(() => expect(chip('Food/Dessert/Cake')).toHaveAttribute('data-coverage', 'all'));
    expect(chip('Food/Fruit')).toHaveAttribute('data-coverage', 'some');
    expect(chip('Travel')).toHaveAttribute('data-coverage', 'none');
    expect(chipButton('Food/Dessert/Cake')).toHaveTextContent('Cake');
    expect(chipButton('Food/Dessert/Cake')).toHaveAttribute('title', 'Food/Dessert/Cake');
    expect(chipButton('Food/Fruit')).toHaveAccessibleName('Food/Fruit, on some of the selected');
    expect(sdkMock.getTagAssetCounts).toHaveBeenCalledWith({ tagAssetCountsDto: { assetIds: ['a', 'b', 'c'] } });
    // the pin of a deleted tag is forgotten
    expect(tagPicker.pinned.current).toEqual(['Food/Dessert/Cake', 'Food/Fruit', 'Travel']);
    expect(screen.queryByTestId('pinned-tags-save')).not.toBeInTheDocument();
  });

  it('stages changes on several chips and saves them all at once', async () => {
    select('a', 'b', 'c');
    renderWithTooltips(PinnedTagsBar, {});
    await waitFor(() => expect(chip('Food/Dessert/Cake')).toHaveAttribute('data-coverage', 'all'));

    await userEvent.click(chipButton('Food/Dessert/Cake'));
    await userEvent.click(chipButton('Travel'));
    await userEvent.click(chipButton('Food/Fruit'));
    expect(chip('Food/Dessert/Cake')).toHaveAttribute('data-change', 'remove');
    expect(chip('Travel')).toHaveAttribute('data-change', 'add');
    expect(chip('Food/Fruit')).toHaveAttribute('data-change', 'add');
    expect(sdkMock.bulkTagAssets).not.toHaveBeenCalled();

    const onAssetsTag = vi.fn();
    const unsubscribe = eventManager.on({ AssetsTag: onAssetsTag });
    await userEvent.click(screen.getByTestId('pinned-tags-save'));

    await waitFor(() => expect(onAssetsTag).toHaveBeenCalledWith(['a', 'b', 'c']));
    unsubscribe();
    expect(sdkMock.bulkTagAssets).toHaveBeenCalledWith({
      tagBulkAssetsDto: { tagIds: ['Travel', 'Food/Fruit'], assetIds: ['a', 'b', 'c'] },
    });
    expect(sdkMock.untagAssets).toHaveBeenCalledWith({ id: 'Food/Dessert/Cake', bulkIdsDto: { ids: ['a', 'b', 'c'] } });
    expect(tagPicker.recent.current).toEqual(['Travel', 'Food/Fruit']);
    // the counts are fetched again and the staged changes are gone
    await waitFor(() => expect(screen.queryByTestId('pinned-tags-save')).not.toBeInTheDocument());
    expect(chip('Travel')).not.toHaveAttribute('data-change');
  });

  it('cycles a tag some assets carry through add, take off and unchanged', async () => {
    select('a', 'b', 'c');
    renderWithTooltips(PinnedTagsBar, {});
    await waitFor(() => expect(chip('Food/Fruit')).toHaveAttribute('data-coverage', 'some'));

    await userEvent.click(chipButton('Food/Fruit'));
    expect(chip('Food/Fruit')).toHaveAttribute('data-change', 'add');
    await userEvent.click(chipButton('Food/Fruit'));
    expect(chip('Food/Fruit')).toHaveAttribute('data-change', 'remove');
    await userEvent.click(chipButton('Food/Fruit'));
    expect(chip('Food/Fruit')).not.toHaveAttribute('data-change');
    expect(screen.queryByTestId('pinned-tags-save')).not.toBeInTheDocument();
  });

  it('discards the staged changes', async () => {
    select('a', 'b', 'c');
    renderWithTooltips(PinnedTagsBar, {});
    await waitFor(() => expect(chip('Food/Dessert/Cake')).toHaveAttribute('data-coverage', 'all'));

    await userEvent.click(chipButton('Travel'));
    await userEvent.click(screen.getByRole('button', { name: 'Discard tag changes' }));

    expect(chip('Travel')).not.toHaveAttribute('data-change');
    expect(sdkMock.bulkTagAssets).not.toHaveBeenCalled();
  });

  it('keeps the staged changes when the selection changes and counts the new selection', async () => {
    select('a', 'b', 'c');
    renderWithTooltips(PinnedTagsBar, {});
    await waitFor(() => expect(chip('Food/Dessert/Cake')).toHaveAttribute('data-coverage', 'all'));
    await userEvent.click(chipButton('Travel'));

    sdkMock.getTagAssetCounts.mockResolvedValue([{ tagId: 'Food/Dessert/Cake', count: 2 }]);
    select('d');

    await waitFor(() => expect(chip('Food/Dessert/Cake')).toHaveAttribute('data-coverage', 'some'));
    expect(sdkMock.getTagAssetCounts).toHaveBeenLastCalledWith({
      tagAssetCountsDto: { assetIds: ['a', 'b', 'c', 'd'] },
    });
    expect(chip('Travel')).toHaveAttribute('data-change', 'add');
  });

  it('unpins a tag from the bar', async () => {
    select('a');
    renderWithTooltips(PinnedTagsBar, {});
    await waitFor(() => expect(chip('Travel')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Unpin Travel' }));

    expect(tagPicker.pinned.current).toEqual(['Food/Dessert/Cake', 'Food/Fruit']);
    expect(screen.getAllByTestId('pinned-tag')).toHaveLength(2);
  });

  it('shows nothing without pinned tags', async () => {
    tagPicker.pinned.current = [];
    select('a');
    renderWithTooltips(PinnedTagsBar, {});

    await waitFor(() => expect(sdkMock.getAllTags).toHaveBeenCalled());
    expect(screen.queryByTestId('pinned-tags-bar')).not.toBeInTheDocument();
    expect(sdkMock.getTagAssetCounts).not.toHaveBeenCalled();
  });
});
