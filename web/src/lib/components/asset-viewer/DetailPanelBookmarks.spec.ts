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

    await user.click(screen.getByRole('button', { name: 'edit_video_bookmark' }));
    const input = screen.getByRole('textbox', { name: 'video_bookmark_label' });
    await user.clear(input);
    await user.type(input, 'Cake{Enter}');

    expect(sdkMock.updateVideoBookmark).toHaveBeenCalledWith({
      id: 'bookmark-1',
      videoBookmarkUpdateDto: { label: 'Cake' },
    });
    expect(await screen.findByText('Cake')).toBeInTheDocument();
  });

  it('moves a bookmark by a second with the buttons and shows the new moment', async () => {
    const user = userEvent.setup();
    const emit = vi.spyOn(assetViewerManager, 'emit');
    sdkMock.getVideoBookmarks.mockResolvedValue([newBookmark()]);
    sdkMock.updateVideoBookmark.mockResolvedValue(newBookmark({ time: 85_000 }));
    await videoBookmarkManager.load('video-1');

    renderWithTooltips(DetailPanelBookmarks, { asset: video });

    await user.click(screen.getByRole('button', { name: 'edit_video_bookmark' }));
    const later = screen.getByRole('button', { name: 'video_bookmark_later' });
    await user.click(later);
    await user.click(later);
    await user.click(screen.getByRole('button', { name: 'video_bookmark_earlier' }));
    await user.click(later);

    expect(screen.getByRole('textbox', { name: 'video_bookmark_time' })).toHaveValue('1:25');
    expect(emit).toHaveBeenLastCalledWith('VideoSeek', 85_000);
    // quick clicks in a row are saved once, with the last position
    await vi.waitFor(() => expect(sdkMock.updateVideoBookmark).toHaveBeenCalledTimes(1));
    expect(sdkMock.updateVideoBookmark).toHaveBeenCalledWith({
      id: 'bookmark-1',
      videoBookmarkUpdateDto: { time: 85_000 },
    });
  });

  it('takes a typed time and flags text that is not a time', async () => {
    const user = userEvent.setup();
    sdkMock.getVideoBookmarks.mockResolvedValue([newBookmark()]);
    sdkMock.updateVideoBookmark.mockResolvedValue(newBookmark({ time: 125_000 }));
    await videoBookmarkManager.load('video-1');

    renderWithTooltips(DetailPanelBookmarks, {
      asset: assetFactory.build({ id: 'video-1', type: AssetTypeEnum.Video, duration: 150_000 }),
    });

    await user.click(screen.getByRole('button', { name: 'edit_video_bookmark' }));
    const field = screen.getByRole('textbox', { name: 'video_bookmark_time' });
    await user.clear(field);
    await user.type(field, 'abc{Enter}');
    expect(field).toHaveAttribute('aria-invalid', 'true');

    await user.clear(field);
    await user.type(field, '2:05{Enter}');
    expect(field).toHaveAttribute('aria-invalid', 'false');
    await vi.waitFor(() =>
      expect(sdkMock.updateVideoBookmark).toHaveBeenCalledWith({
        id: 'bookmark-1',
        videoBookmarkUpdateDto: { time: 125_000 },
      }),
    );

    // arrow keys nudge too, and the time never goes past the end of the video
    await user.clear(field);
    await user.type(field, '9:00{Enter}');
    expect(field).toHaveValue('2:30');
    await user.type(field, '{ArrowDown}');
    expect(field).toHaveValue('2:29');
  });

  it('shows a hint when the video has no bookmarks yet', async () => {
    sdkMock.getVideoBookmarks.mockResolvedValue([]);
    await videoBookmarkManager.load('video-1');

    renderWithTooltips(DetailPanelBookmarks, { asset: video });

    expect(screen.getByText('no_video_bookmarks')).toBeInTheDocument();
  });
});
