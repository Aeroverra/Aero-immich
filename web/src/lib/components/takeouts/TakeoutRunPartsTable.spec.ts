import { TakeoutRunPartStatus } from '@immich/sdk';
import { render, screen, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import TakeoutRunPartsTable from '$lib/components/takeouts/TakeoutRunPartsTable.svelte';
import { takeoutRunPartStatsFactory } from '@test-data/factories/takeout-factory';

const MiB = 2 ** 20;
const GiB = 2 ** 30;

describe('TakeoutRunPartsTable component', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  it('shows the state, bytes read and speed of each part', () => {
    const read = takeoutRunPartStatsFactory.build({
      partId: 'p1',
      status: TakeoutRunPartStatus.Read,
      size: GiB,
      bytesRead: GiB,
      passes: 1,
      staged: 12,
      stagedBytes: 300 * MiB,
      duplicates: 40,
      deferred: 2,
      startedAt: '2026-09-28T12:00:00.000Z',
      finishedAt: '2026-09-28T12:00:32.000Z',
    });
    const cached = takeoutRunPartStatsFactory.build({ partId: 'p2', status: TakeoutRunPartStatus.Cached });

    render(TakeoutRunPartsTable, { parts: [read, cached] });

    const row = within(screen.getByTestId('run-part-p1'));
    expect(row.getByText('Read')).toBeInTheDocument();
    expect(row.getAllByText('1 GiB')).toHaveLength(2);
    expect(row.getByText('32 MiB/s')).toBeInTheDocument();
    expect(row.getByText('12')).toBeInTheDocument();
    expect(row.getByText('300 MiB')).toBeInTheDocument();
    expect(row.getByText('40')).toBeInTheDocument();
    expect(row.queryByText('Read twice')).not.toBeInTheDocument();

    expect(within(screen.getByTestId('run-part-p2')).getByText('Read earlier')).toBeInTheDocument();
  });

  it('flags a part that was read more than once', () => {
    render(TakeoutRunPartsTable, {
      parts: [
        takeoutRunPartStatsFactory.build({ partId: 'twice', status: TakeoutRunPartStatus.Read, passes: 2 }),
        takeoutRunPartStatsFactory.build({ partId: 'thrice', status: TakeoutRunPartStatus.Read, passes: 3 }),
      ],
    });

    expect(within(screen.getByTestId('run-part-twice')).getByText('Read twice')).toBeInTheDocument();
    expect(within(screen.getByTestId('run-part-thrice')).getByText('Read 3 times')).toBeInTheDocument();
  });

  it('shows the error of a part with its offset', () => {
    render(TakeoutRunPartsTable, {
      parts: [
        takeoutRunPartStatsFactory.build({
          partId: 'bad',
          status: TakeoutRunPartStatus.Error,
          size: 5000,
          error: 'unexpected end of file',
          errorOffset: 1234,
        }),
      ],
    });

    const row = within(screen.getByTestId('run-part-bad'));
    expect(row.getByText('Error')).toBeInTheDocument();
    expect(row.getByText('unexpected end of file')).toBeInTheDocument();
    expect(row.getByText('Error at byte 1,234 of 5,000')).toBeInTheDocument();
  });

  it('shows the retry, fetch and entry error columns only when a part needs them', () => {
    const { unmount } = render(TakeoutRunPartsTable, {
      parts: [takeoutRunPartStatsFactory.build({ status: TakeoutRunPartStatus.Read })],
    });
    expect(screen.queryByRole('columnheader', { name: 'Retries' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Read again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Unreadable files' })).not.toBeInTheDocument();
    unmount();

    render(TakeoutRunPartsTable, {
      parts: [
        takeoutRunPartStatsFactory.build({
          status: TakeoutRunPartStatus.Read,
          transportRetries: 3,
          fetchBytesRead: 5 * MiB,
          entryErrors: 1,
        }),
      ],
    });
    expect(screen.getByRole('columnheader', { name: 'Retries' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Read again' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Unreadable files' })).toBeInTheDocument();
    expect(screen.getByText('5 MiB')).toBeInTheDocument();
  });

  it('shows a paused part with its progress, and leaves the paused time out of its speed', () => {
    const paused = takeoutRunPartStatsFactory.build({
      partId: 'p1',
      status: TakeoutRunPartStatus.Paused,
      size: 2 * GiB,
      position: GiB,
      bytesRead: 640 * MiB,
      // 30 s paused earlier, then 10 s read until the run was paused at 12:01:00
      startedAt: '2026-09-29T12:00:20.000Z',
      pausedMs: 30_000,
    });
    const done = takeoutRunPartStatsFactory.build({
      partId: 'p2',
      status: TakeoutRunPartStatus.Read,
      size: GiB,
      bytesRead: GiB,
      startedAt: '2026-09-29T11:00:00.000Z',
      finishedAt: '2026-09-29T11:01:04.000Z',
      pausedMs: 32_000,
    });

    render(TakeoutRunPartsTable, { parts: [paused, done], pausedAt: '2026-09-29T12:01:00.000Z' });

    const row = within(screen.getByTestId('run-part-p1'));
    expect(row.getByText('Paused')).toBeInTheDocument();
    expect(row.getByRole('progressbar')).toBeInTheDocument();
    expect(row.getByText('64 MiB/s')).toBeInTheDocument();
    expect(within(screen.getByTestId('run-part-p2')).getByText('32 MiB/s')).toBeInTheDocument();
  });
});
