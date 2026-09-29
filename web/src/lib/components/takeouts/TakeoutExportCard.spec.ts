import { TakeoutCompleteness, TakeoutRunStatus } from '@immich/sdk';
import { render, screen, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import TakeoutExportCard from '$lib/components/takeouts/TakeoutExportCard.svelte';
import { takeoutExportFactory, takeoutRunFactory } from '@test-data/factories/takeout-factory';

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));

const GiB = 2 ** 30;

describe('TakeoutExportCard component', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  it('says the parts are being checked until the analysis ran', () => {
    render(TakeoutExportCard, { exp: takeoutExportFactory.build({ completeness: TakeoutCompleteness.Unknown }) });

    expect(screen.getByText('Checking parts')).toBeInTheDocument();
    expect(screen.queryByText('Scanning')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-card-run')).not.toBeInTheDocument();
  });

  it('offers Run import for a complete export without an active run', () => {
    render(TakeoutExportCard, { exp: takeoutExportFactory.build({ completeness: TakeoutCompleteness.Complete }) });

    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run import' })).toBeEnabled();
  });

  it('shows the reading phase of an active run with its archive bar', () => {
    const lastRun = takeoutRunFactory.build({
      status: TakeoutRunStatus.Reading,
      archiveBytesRead: 2 * GiB,
      archiveBytesTotal: 8 * GiB,
    });
    render(TakeoutExportCard, { exp: takeoutExportFactory.build({ lastRun }) });

    const run = within(screen.getByTestId('export-card-run'));
    expect(run.getByText('Reading')).toBeInTheDocument();
    expect(run.getByText('2 GiB / 8 GiB')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run import' })).toBeDisabled();
  });

  it('shows asset creation in media bytes', () => {
    const lastRun = takeoutRunFactory.build({
      status: TakeoutRunStatus.Importing,
      bytesDone: GiB,
      bytesTotal: 3 * GiB,
    });
    render(TakeoutExportCard, { exp: takeoutExportFactory.build({ lastRun }) });

    const run = within(screen.getByTestId('export-card-run'));
    expect(run.getByText('Creating assets')).toBeInTheDocument();
    expect(run.getByText('1 GiB / 3 GiB')).toBeInTheDocument();
  });

  it('shows only the status of phases without a byte bar', () => {
    const lastRun = takeoutRunFactory.build({ status: TakeoutRunStatus.Planning });
    render(TakeoutExportCard, { exp: takeoutExportFactory.build({ lastRun }) });

    const run = within(screen.getByTestId('export-card-run'));
    expect(run.getByText('Planning')).toBeInTheDocument();
    expect(run.queryByText(/\//)).not.toBeInTheDocument();
  });

  it('shows nothing about a finished run', () => {
    const lastRun = takeoutRunFactory.build({ status: TakeoutRunStatus.Completed });
    render(TakeoutExportCard, { exp: takeoutExportFactory.build({ lastRun }) });

    expect(screen.queryByTestId('export-card-run')).not.toBeInTheDocument();
  });
});
