import { TakeoutCompleteness, TakeoutRunStatus } from '@immich/sdk';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
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

  it('counts the parts against the expected parts, not the files the index lists', () => {
    // family export: 15 parts, an index listing 89928 files; the card said "16 of 89928 parts"
    render(TakeoutExportCard, {
      exp: takeoutExportFactory.build({ partCount: 15, expectedPartCount: 15, indexFileCount: 89_928 }),
    });

    expect(screen.getByText('15 of 15 parts')).toBeInTheDocument();
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

  it('pauses the active run from the card', async () => {
    const lastRun = takeoutRunFactory.build({
      status: TakeoutRunStatus.Importing,
      bytesDone: GiB,
      bytesTotal: 3 * GiB,
    });
    const paused = { ...lastRun, status: TakeoutRunStatus.Paused, pausedFrom: TakeoutRunStatus.Importing };
    sdkMock.pauseTakeoutRun.mockResolvedValue(paused);
    const onRunChanged = vi.fn();
    render(TakeoutExportCard, { exp: takeoutExportFactory.build({ lastRun }), onRunChanged });

    await userEvent.click(screen.getByRole('button', { name: 'Pause run' }));
    expect(sdkMock.pauseTakeoutRun).toHaveBeenCalledExactlyOnceWith({ id: lastRun.id });
    expect(onRunChanged).toHaveBeenCalledExactlyOnceWith(paused);
  });

  it('shows a paused run in the phase it was paused in, with Resume, and no new run', async () => {
    const lastRun = takeoutRunFactory.build({
      status: TakeoutRunStatus.Paused,
      pausedFrom: TakeoutRunStatus.Reading,
      pausedAt: '2026-09-29T10:00:00.000Z',
      archiveBytesRead: 2 * GiB,
      archiveBytesTotal: 8 * GiB,
    });
    sdkMock.resumeTakeoutRun.mockResolvedValue({ ...lastRun, status: TakeoutRunStatus.Reading });
    render(TakeoutExportCard, { exp: takeoutExportFactory.build({ lastRun }) });

    const run = within(screen.getByTestId('export-card-run'));
    expect(run.getByText('Paused: Reading')).toBeInTheDocument();
    expect(run.getByText('2 GiB / 8 GiB')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run import' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Resume run' }));
    expect(sdkMock.resumeTakeoutRun).toHaveBeenCalledExactlyOnceWith({ id: lastRun.id });
  });
});
