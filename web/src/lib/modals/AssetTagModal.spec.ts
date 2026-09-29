import type { TagResponseDto } from '@immich/sdk';
import { screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { tagPicker } from '$lib/components/tags/tag-picker.svelte';
import AssetTagModal from '$lib/modals/AssetTagModal.svelte';
import { renderWithTooltips } from '$tests/helpers';

const newTag = (value: string): TagResponseDto => ({
  id: value,
  value,
  name: value.split('/').at(-1)!,
  isHidden: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('AssetTagModal', () => {
  const assetIds = ['a', 'b', 'c'];
  const onClose = vi.fn();

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    tagPicker.expanded.current = [];
    tagPicker.recent.current = [];
    sdkMock.getAllTags.mockResolvedValue([newTag('Beach'), newTag('Family'), newTag('Work')]);
    // all three assets carry Beach, one carries Family, none carries Work
    sdkMock.getTagAssetCounts.mockResolvedValue([
      { tagId: 'Beach', count: 3 },
      { tagId: 'Family', count: 1 },
    ]);
    sdkMock.bulkTagAssets.mockResolvedValue({ count: 3 });
    sdkMock.untagAssets.mockResolvedValue([]);
  });

  const row = (value: string) => screen.getByRole('treeitem', { name: new RegExp(value) });

  it('shows which tags all, some or none of the assets have', async () => {
    renderWithTooltips(AssetTagModal, { assetIds, onClose });

    await waitFor(() => expect(row('Beach')).toHaveAttribute('aria-selected', 'true'));
    expect(row('Family')).toHaveAttribute('data-partial');
    expect(row('Family')).toHaveAttribute('aria-selected', 'false');
    expect(row('Work')).not.toHaveAttribute('data-partial');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('takes an unchecked tag off every asset and adds a checked one to all of them', async () => {
    renderWithTooltips(AssetTagModal, { assetIds, onClose });
    await waitFor(() => expect(row('Beach')).toHaveAttribute('aria-selected', 'true'));

    await userEvent.click(screen.getByLabelText('Beach'));
    await userEvent.click(screen.getByLabelText('Family'));
    expect(screen.getByTestId('tag-changes-remove')).toHaveTextContent('Beach');
    expect(screen.getByTestId('tag-changes-add')).toHaveTextContent('Family');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(sdkMock.bulkTagAssets).toHaveBeenCalledWith({ tagBulkAssetsDto: { tagIds: ['Family'], assetIds } });
    expect(sdkMock.untagAssets).toHaveBeenCalledWith({ id: 'Beach', bulkIdsDto: { ids: assetIds } });
  });

  it('changes nothing when a tag is toggled back', async () => {
    renderWithTooltips(AssetTagModal, { assetIds, onClose });
    await waitFor(() => expect(row('Beach')).toHaveAttribute('aria-selected', 'true'));

    await userEvent.click(screen.getByLabelText('Work'));
    await userEvent.click(screen.getByLabelText('Work'));

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
