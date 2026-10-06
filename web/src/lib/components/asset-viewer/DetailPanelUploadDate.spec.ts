import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/svelte';
import DetailPanelUploadDate from '$lib/components/asset-viewer/DetailPanelUploadDate.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';

// i18n is not loaded here: translated parts come back as their keys
describe('DetailPanelUploadDate component', () => {
  it('shows the Google Photos upload date and when an import reached Immich', () => {
    const asset = assetFactory.build({ createdAt: '2026-09-20T12:00:00.000Z', uploadedAt: '2019-03-10T12:30:00.000Z' });

    render(DetailPanelUploadDate, { props: { asset } });

    const row = screen.getByTestId('detail-panel-upload-date');
    expect(row).toHaveTextContent('2019');
    expect(row).toHaveTextContent('uploaded');
    expect(row).toHaveTextContent('added_to_immich_date');
  });

  it('shows one date for an asset uploaded straight to Immich', () => {
    const asset = assetFactory.build({ createdAt: '2026-06-15T12:00:00.000Z', uploadedAt: '2026-06-15T12:00:00.000Z' });

    render(DetailPanelUploadDate, { props: { asset } });

    const row = screen.getByTestId('detail-panel-upload-date');
    expect(row).toHaveTextContent('2026');
    expect(row).not.toHaveTextContent('added_to_immich_date');
  });

  it('falls back to the creation date when the server does not send the upload date', () => {
    const asset = assetFactory.build({ createdAt: '2026-06-15T12:00:00.000Z', uploadedAt: undefined });

    render(DetailPanelUploadDate, { props: { asset } });

    expect(screen.getByTestId('detail-panel-upload-date')).toHaveTextContent('2026');
  });
});
