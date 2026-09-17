import { getAssetMetadata } from '@immich/sdk';
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { assetFactory } from '@test-data/factories/asset-factory';
import DetailPanelMetadata from './DetailPanelMetadata.svelte';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAssetMetadata: vi.fn(),
}));

describe('DetailPanelMetadata', () => {
  beforeEach(() => {
    vi.mocked(getAssetMetadata).mockReset();
  });

  it('shows the Google Photos link and the metadata on demand', async () => {
    vi.mocked(getAssetMetadata).mockResolvedValue([
      {
        key: 'google-photos',
        updatedAt: '2026-01-01T00:00:00.000Z',
        value: { url: 'https://photos.google.com/photo/abc', views: 3, appPackage: 'com.whatsapp' },
      },
    ]);
    const user = userEvent.setup();

    render(DetailPanelMetadata, { props: { asset: assetFactory.build({ id: 'asset-a' }), isOwner: true } });

    const link = await screen.findByRole('link', { name: /open_in_google_photos/ });
    expect(link).toHaveAttribute('href', 'https://photos.google.com/photo/abc');
    expect(screen.queryByText(/com\.whatsapp/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /asset_metadata/ }));
    expect(screen.getByText('google-photos')).toBeInTheDocument();
    expect(screen.getByText(/com\.whatsapp/)).toBeInTheDocument();
  });

  it('ignores links that do not point to Google Photos', async () => {
    vi.mocked(getAssetMetadata).mockResolvedValue([
      { key: 'google-photos', updatedAt: '2026-01-01T00:00:00.000Z', value: { url: 'https://example.com/x' } },
    ]);

    render(DetailPanelMetadata, { props: { asset: assetFactory.build(), isOwner: true } });

    await screen.findByRole('button', { name: /asset_metadata/ });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('stays hidden without metadata or for other users', async () => {
    vi.mocked(getAssetMetadata).mockResolvedValue([]);
    const { rerender } = render(DetailPanelMetadata, { props: { asset: assetFactory.build(), isOwner: true } });
    await waitFor(() => expect(getAssetMetadata).toHaveBeenCalled());
    expect(screen.queryByTestId('detail-panel-metadata')).not.toBeInTheDocument();

    vi.mocked(getAssetMetadata).mockClear();
    await rerender({ asset: assetFactory.build(), isOwner: false });
    expect(getAssetMetadata).not.toHaveBeenCalled();
    expect(screen.queryByTestId('detail-panel-metadata')).not.toBeInTheDocument();
  });
});
