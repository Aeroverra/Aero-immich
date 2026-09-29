import { AssetTypeEnum, type VideoBookmarkResponseDto } from '@immich/sdk';
import '@testing-library/jest-dom';
import { screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { videoBookmarkManager } from '$lib/managers/video-bookmark-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import DetailPanelBookmarks from './DetailPanelBookmarks.svelte';

const newBookmark = (overrides: Partial<VideoBookmarkResponseDto> = {}): VideoBookmarkResponseDto => ({
  id: 'bookmark-1',
  assetId: 'video-1',
  time: 83_000,
  label: 'Candles',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('DetailPanelBookmarks', () => {
  const video = assetFactory.build({ id: 'video-1', type: AssetTypeEnum.Video });

  beforeEach(() => {
    vi.clearAllMocks();
    videoBookmarkManager.clear();
  });

  it('is hidden for photos', () => {
    renderWithTooltips(DetailPanelBookmarks, { asset: assetFactory.build({ type: AssetTypeEnum.Image }) });

    expect(screen.queryByTestId('detail-panel-bookmarks')).not.toBeInTheDocument();
  });

  it('lists bookmarks and plays from one when clicked', async () => {
    const user = userEvent.setup();
    const emit = vi.spyOn(assetViewerManager, 'emit');
    sdkMock.getVideoBookmarks.mockResolvedValue([
      newBookmark(),
      newBookmark({ id: 'bookmark-2', time: 5000, label: '' }),
    ]);
    await videoBookmarkManager.load('video-1');

    renderWithTooltips(DetailPanelBookmarks, { asset: video });

    expect(screen.getByText('Candles')).toBeInTheDocument();
    expect(screen.getByText('video_bookmark_untitled')).toBeInTheDocument();
    await user.click(screen.getByText('Candles'));
    expect(emit).toHaveBeenCalledWith('VideoSeek', 83_000, true);
  });

  it('renames a bookmark with Enter', async () => {
    const user = userEvent.setup();
    sdkMock.getVideoBookmarks.mockResolvedValue([newBookmark()]);
    sdkMock.updateVideoBookmark.mockResolvedValue(newBookmark({ label: 'Cake' }));
    await videoBookmarkManager.load('video-1');

    renderWithTooltips(DetailPanelBookmarks, { asset: video });

    await user.click(screen.getByRole('button', { name: 'rename_video_bookmark' }));
    const input = screen.getByRole('textbox', { name: 'video_bookmark_label' });
    await user.clear(input);
    await user.type(input, 'Cake{Enter}');

    expect(sdkMock.updateVideoBookmark).toHaveBeenCalledWith({
      id: 'bookmark-1',
      videoBookmarkUpdateDto: { label: 'Cake' },
    });
    expect(await screen.findByText('Cake')).toBeInTheDocument();
  });

  it('shows a hint when the video has no bookmarks yet', async () => {
    sdkMock.getVideoBookmarks.mockResolvedValue([]);
    await videoBookmarkManager.load('video-1');

    renderWithTooltips(DetailPanelBookmarks, { asset: video });

    expect(screen.getByText('no_video_bookmarks')).toBeInTheDocument();
  });
});
