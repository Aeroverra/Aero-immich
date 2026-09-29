import { TakeoutRunPartStatus, TakeoutRunStatus } from '@immich/sdk';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import TakeoutRunProgress from '$lib/components/takeouts/TakeoutRunProgress.svelte';
import { takeoutRunFactory, takeoutRunPartStatsFactory } from '@test-data/factories/takeout-factory';

const GiB = 2 ** 30;

const phaseNames = () =>
  within(screen.getByRole('list', { name: 'Status' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent?.trim());

describe('TakeoutRunProgress component', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  it('steps through reading, planning, creating assets and finishing', () => {
    render(TakeoutRunProgress, { run: takeoutRunFactory.build({ status: TakeoutRunStatus.Planning }) });

    expect(phaseNames()).toEqual(['Reading', 'Planning', 'Creating assets', 'Finishing']);
    expect(screen.getByText('Planning', { selector: 'li' })).toHaveAttribute('aria-current', 'step');
    expect(screen.queryByText('Scanning')).not.toBeInTheDocument();
  });

  it('adds the fetching step and its bar when the run fetches files', () => {
    render(TakeoutRunProgress, {
      run: takeoutRunFactory.build({
        status: TakeoutRunStatus.Fetching,
        readStats: { fetchFiles: 1, fetchBytesRead: GiB, fetchBytesTotal: 2 * GiB, etaSeconds: 90 },
      }),
    });

    expect(phaseNames()).toEqual(['Reading', 'Planning', 'Fetching', 'Creating assets', 'Finishing']);
    const fetching = within(screen.getByRole('region', { name: 'Fetching' }));
    expect(fetching.getByText(/1 GiB \/ 2 GiB/)).toHaveTextContent('1m 30s');
  });

  it('shows what the reading found so far, with the server ETA and the parts', () => {
    const part = takeoutRunPartStatsFactory.build({
      partId: 'p1',
      fileName: 'takeout-20260101T000000Z-003.tgz',
      status: TakeoutRunPartStatus.Reading,
      position: GiB,
      size: 2 * GiB,
    });
    render(TakeoutRunProgress, {
      run: takeoutRunFactory.build({
        status: TakeoutRunStatus.Reading,
        archiveBytesRead: 3 * GiB,
        archiveBytesTotal: 12 * GiB,
        readStats: {
          filesFound: 12_345,
          serverDuplicatesSkipped: 10_000,
          localDuplicatesSkipped: 20,
          stagedFiles: 2000,
          stagedBytes: 3 * GiB,
          deferredFiles: 4,
          etaSeconds: 3725,
          parts: [part],
        },
      }),
    });

    const reading = within(screen.getByRole('region', { name: 'Reading' }));
    expect(reading.getByText(/3 GiB \/ 12 GiB/)).toHaveTextContent('1h 2m');
    const tiles = within(screen.getByTestId('read-tiles'));
    const tile = (label: string) => tiles.getByText(label).closest('div')!;
    expect(tile('Files found')).toHaveTextContent('12,345');
    expect(tile('Already on the server')).toHaveTextContent('10,000');
    expect(tile('Same file seen earlier')).toHaveTextContent('20');
    expect(tile('Staged')).toHaveTextContent('2,000');
    expect(tile('Staged')).toHaveTextContent('3 GiB');
    expect(tile('Checked later')).toHaveTextContent('4');
    expect(reading.getByText('takeout-20260101T000000Z-003.tgz')).toBeInTheDocument();
    expect(screen.queryByText('Scans wait while two imports run.')).not.toBeInTheDocument();
  });

  it('leaves the parts table out when asked', () => {
    render(TakeoutRunProgress, {
      run: takeoutRunFactory.build({
        status: TakeoutRunStatus.Reading,
        readStats: { parts: [takeoutRunPartStatsFactory.build({ fileName: 'takeout-x-001.tgz' })] },
      }),
      showParts: false,
    });

    expect(screen.queryByText('takeout-x-001.tgz')).not.toBeInTheDocument();
  });

  it('measures asset creation in media bytes and files', () => {
    render(TakeoutRunProgress, {
      run: takeoutRunFactory.build({
        status: TakeoutRunStatus.Importing,
        bytesDone: GiB,
        bytesTotal: 4 * GiB,
        counters: { result: { uploaded: 25, toUpload: 100 } },
      }),
    });

    const creating = within(screen.getByRole('region', { name: 'Creating assets' }));
    expect(creating.getByText(/1 GiB \/ 4 GiB/)).toBeInTheDocument();
    expect(creating.getByText('25 of 100 files')).toBeInTheDocument();
    expect(screen.getByText('Creating assets', { selector: 'li' })).toHaveAttribute('aria-current', 'step');
  });

  it('notes that finishing copies files when staging is on another disk', () => {
    render(TakeoutRunProgress, {
      run: takeoutRunFactory.build({ status: TakeoutRunStatus.Importing, readStats: { crossDevice: true } }),
    });

    expect(screen.getByText('Staging is on another disk, finishing copies files.')).toBeInTheDocument();
  });

  it.each([
    { status: TakeoutRunStatus.Reading, shown: true },
    { status: TakeoutRunStatus.Queued, shown: true },
    { status: TakeoutRunStatus.Cancelling, shown: false },
    { status: TakeoutRunStatus.Completed, shown: false },
    { status: TakeoutRunStatus.Failed, shown: false },
  ])('offers Cancel for a $status run: $shown', ({ status, shown }) => {
    render(TakeoutRunProgress, { run: takeoutRunFactory.build({ status }) });

    const button = screen.queryByRole('button', { name: 'Cancel run' });
    if (shown) {
      expect(button).toBeInTheDocument();
    } else {
      expect(button).not.toBeInTheDocument();
    }
  });

  describe('pause and resume', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('pauses a running run and hands the paused run back', async () => {
      const run = takeoutRunFactory.build({ status: TakeoutRunStatus.Reading });
      const paused = {
        ...run,
        status: TakeoutRunStatus.Paused,
        pausedFrom: TakeoutRunStatus.Reading,
        pausedAt: '2026-09-29T10:00:00.000Z',
      };
      sdkMock.pauseTakeoutRun.mockResolvedValue(paused);
      const onUpdated = vi.fn();
      render(TakeoutRunProgress, { run, onUpdated });

      expect(screen.queryByRole('button', { name: 'Resume run' })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Pause run' }));

      expect(sdkMock.pauseTakeoutRun).toHaveBeenCalledExactlyOnceWith({ id: run.id });
      expect(onUpdated).toHaveBeenCalledExactlyOnceWith(paused);
    });

    it('shows a paused run in its phase, without an ETA, with Resume and Cancel', async () => {
      const run = takeoutRunFactory.build({
        status: TakeoutRunStatus.Paused,
        pausedFrom: TakeoutRunStatus.Reading,
        pausedAt: '2026-09-29T10:00:00.000Z',
        archiveBytesRead: 3 * GiB,
        archiveBytesTotal: 12 * GiB,
        readStats: { etaSeconds: 3725 },
      });
      const resumed = { ...run, status: TakeoutRunStatus.Reading, pausedFrom: null, pausedAt: null };
      sdkMock.resumeTakeoutRun.mockResolvedValue(resumed);
      const onUpdated = vi.fn();
      render(TakeoutRunProgress, { run, onUpdated });

      expect(screen.getByText('Reading', { selector: 'li' })).toHaveAttribute('aria-current', 'step');
      const reading = within(screen.getByRole('region', { name: 'Reading' }));
      expect(reading.getByText(/3 GiB \/ 12 GiB/)).not.toHaveTextContent('1h 2m');
      expect(screen.getByTestId('takeout-run-paused')).toHaveTextContent('Paused since');
      expect(screen.queryByRole('button', { name: 'Pause run' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel run' })).toBeEnabled();

      await userEvent.click(screen.getByRole('button', { name: 'Resume run' }));
      expect(sdkMock.resumeTakeoutRun).toHaveBeenCalledExactlyOnceWith({ id: run.id });
      expect(onUpdated).toHaveBeenCalledExactlyOnceWith(resumed);
    });

    it('offers neither Pause nor Resume while the run is cancelling', () => {
      render(TakeoutRunProgress, { run: takeoutRunFactory.build({ status: TakeoutRunStatus.Cancelling }) });
      expect(screen.queryByRole('button', { name: 'Pause run' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Resume run' })).not.toBeInTheDocument();
    });
  });
});
