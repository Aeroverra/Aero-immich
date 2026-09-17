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

// the expanded state is remembered across renders, so set it explicitly
const setExpanded = async (user: ReturnType<typeof userEvent.setup>, expanded: boolean) => {
  const toggle = await screen.findByRole('button', { name: /^asset_metadata$/ });
  if (toggle.getAttribute('aria-expanded') !== String(expanded)) {
    await user.click(toggle);
  }
};

describe('DetailPanelMetadata', () => {
  beforeEach(() => {
    vi.mocked(getAssetMetadata).mockReset();
  });

  it('shows the Google Photos link and readable fields on demand', async () => {
    vi.mocked(getAssetMetadata).mockResolvedValue([
      {
        key: 'google-photos',
        updatedAt: '2026-01-01T00:00:00.000Z',
        value: {
          url: 'https://photos.google.com/photo/abc',
          views: 3,
          appPackage: 'com.whatsapp',
          origin: 'mobileUpload',
          people: ['Thomas', 'Graham'],
        },
      },
    ]);
    const user = userEvent.setup();

    render(DetailPanelMetadata, { props: { asset: assetFactory.build({ id: 'asset-a' }), isOwner: true } });

    const link = await screen.findByRole('link', { name: /open_in_google_photos/ });
    expect(link).toHaveAttribute('href', 'https://photos.google.com/photo/abc');

    await setExpanded(user, false);
    expect(screen.queryByText('com.whatsapp')).not.toBeInTheDocument();

    await setExpanded(user, true);
    expect(screen.getByText('asset_metadata_app')).toBeInTheDocument();
    expect(screen.getByText('com.whatsapp')).toBeInTheDocument();
    expect(screen.getByText('asset_metadata_origin_mobile_upload')).toBeInTheDocument();
    expect(screen.getByText('Thomas, Graham')).toBeInTheDocument();
    expect(screen.queryByText(/"appPackage"/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /asset_metadata_show_raw/ }));
    expect(screen.getByText(/"appPackage"/)).toBeInTheDocument();
  });

  it('ignores links that do not point to Google Photos', async () => {
    vi.mocked(getAssetMetadata).mockResolvedValue([
      { key: 'google-photos', updatedAt: '2026-01-01T00:00:00.000Z', value: { url: 'https://example.com/x' } },
    ]);

    render(DetailPanelMetadata, { props: { asset: assetFactory.build(), isOwner: true } });

    await screen.findByRole('button', { name: /^asset_metadata$/ });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows other keys as plain fields and hides internal keys', async () => {
    vi.mocked(getAssetMetadata).mockResolvedValue([
      { key: 'mobile-app', updatedAt: '2026-01-01T00:00:00.000Z', value: { iCloudId: 'secret-id' } },
      { key: 'my-import', updatedAt: '2026-01-01T00:00:00.000Z', value: { album: 'Trip', rating: 4 } },
    ]);
    const user = userEvent.setup();

    render(DetailPanelMetadata, { props: { asset: assetFactory.build(), isOwner: true } });

    await setExpanded(user, true);
    expect(screen.getByText('my-import')).toBeInTheDocument();
    expect(screen.getByText('album')).toBeInTheDocument();
    expect(screen.getByText('Trip')).toBeInTheDocument();
    expect(screen.queryByText(/secret-id/)).not.toBeInTheDocument();
  });

  it('stays hidden without metadata, with only internal keys or for other users', async () => {
    vi.mocked(getAssetMetadata).mockResolvedValue([
      { key: 'mobile-app', updatedAt: '2026-01-01T00:00:00.000Z', value: { iCloudId: 'x' } },
    ]);
    const { rerender } = render(DetailPanelMetadata, { props: { asset: assetFactory.build(), isOwner: true } });
    await waitFor(() => expect(getAssetMetadata).toHaveBeenCalled());
    expect(screen.queryByTestId('detail-panel-metadata')).not.toBeInTheDocument();

    vi.mocked(getAssetMetadata).mockClear();
    await rerender({ asset: assetFactory.build(), isOwner: false });
    expect(getAssetMetadata).not.toHaveBeenCalled();
    expect(screen.queryByTestId('detail-panel-metadata')).not.toBeInTheDocument();
  });
});
