import { AssetTypeEnum } from '@immich/sdk';
import '@testing-library/jest-dom';
import { screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { videoTranscriptManager } from '$lib/managers/video-transcript-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import DetailPanelTranscript from './DetailPanelTranscript.svelte';

const transcript = {
  assetId: 'video-1',
  language: 'en',
  segments: [
    { startTime: 110, endTime: 4490, text: "I'm going to do the best I can because I'm driving." },
    { startTime: 6790, endTime: 14_850, text: 'But I just went to the last full moon party.' },
    { startTime: 484_000, endTime: 488_000, text: 'And I don’t know what to feel.' },
  ],
};

describe('DetailPanelTranscript', () => {
  const video = assetFactory.build({ id: 'video-1', type: AssetTypeEnum.Video });

  beforeAll(() => {
    URL.createObjectURL = vi.fn(() => 'blob:captions');
    URL.revokeObjectURL = vi.fn();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    videoTranscriptManager.clear();
  });

  it('is hidden for photos', () => {
    renderWithTooltips(DetailPanelTranscript, { asset: assetFactory.build({ type: AssetTypeEnum.Image }) });

    expect(screen.queryByTestId('detail-panel-transcript')).not.toBeInTheDocument();
  });

  it('is hidden when the video has no speech', async () => {
    sdkMock.getAssetTranscript.mockResolvedValue({ assetId: 'video-1', language: null, segments: [] });
    await videoTranscriptManager.load('video-1');

    renderWithTooltips(DetailPanelTranscript, { asset: video });

    expect(screen.queryByTestId('detail-panel-transcript')).not.toBeInTheDocument();
    expect(videoTranscriptManager.captionsUrl).toBeUndefined();
  });

  it('lists the lines and plays from one when clicked', async () => {
    const user = userEvent.setup();
    const emit = vi.spyOn(assetViewerManager, 'emit');
    sdkMock.getAssetTranscript.mockResolvedValue(transcript);
    await videoTranscriptManager.load('video-1');

    renderWithTooltips(DetailPanelTranscript, { asset: video });

    expect(screen.getByText('8:04')).toBeInTheDocument();
    await user.click(screen.getByText('But I just went to the last full moon party.'));
    expect(emit).toHaveBeenCalledWith('VideoSeek', 6790, true);
    expect(videoTranscriptManager.captionsUrl).toBe('blob:captions');
  });

  it('marks the line being said', async () => {
    sdkMock.getAssetTranscript.mockResolvedValue(transcript);
    await videoTranscriptManager.load('video-1');
    videoTranscriptManager.setPlayback('video-1', 10_000, false);

    renderWithTooltips(DetailPanelTranscript, { asset: video });

    const current = screen.getAllByRole('button').filter((button) => button.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('full moon party');
  });

  it('filters the lines with the search field', async () => {
    const user = userEvent.setup();
    sdkMock.getAssetTranscript.mockResolvedValue(transcript);
    await videoTranscriptManager.load('video-1');

    renderWithTooltips(DetailPanelTranscript, { asset: video });

    await user.type(screen.getByRole('searchbox', { name: 'transcript_search' }), 'moon');
    expect(screen.queryByText(/driving/)).not.toBeInTheDocument();
    expect(screen.getByText(/full moon party/)).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'transcript_search' }), ' nothing');
    expect(screen.getByText('transcript_no_matches')).toBeInTheDocument();
  });
});
