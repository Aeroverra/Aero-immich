import { TakeoutPartReadStatus } from '@immich/sdk';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import TakeoutPartsTable from '$lib/components/takeouts/TakeoutPartsTable.svelte';
import { takeoutPartFactory } from '@test-data/factories/takeout-factory';

const GiB = 2 ** 30;

describe('TakeoutPartsTable component', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  it.each([
    { readStatus: TakeoutPartReadStatus.NotRead, label: 'Not read yet' },
    { readStatus: TakeoutPartReadStatus.Reading, label: 'Reading' },
    { readStatus: TakeoutPartReadStatus.Partial, label: 'Partly read' },
    { readStatus: TakeoutPartReadStatus.Read, label: 'Read' },
    { readStatus: TakeoutPartReadStatus.Missing, label: 'Missing' },
  ])('shows the read state $readStatus as $label', ({ readStatus, label }) => {
    render(TakeoutPartsTable, { parts: [takeoutPartFactory.build({ id: 'p', readStatus })] });

    expect(within(screen.getByTestId('part-p')).getByText(label)).toBeInTheDocument();
  });

  it('shows the bytes read and the file count of a read part', () => {
    render(TakeoutPartsTable, {
      parts: [
        takeoutPartFactory.build({
          id: 'p',
          readStatus: TakeoutPartReadStatus.Read,
          bytesRead: 2 * GiB,
          entryCount: 1234,
        }),
      ],
    });

    expect(within(screen.getByTestId('part-p')).getByText('2 GiB read · 1,234 files')).toBeInTheDocument();
  });

  it('shows where a part failed and offers to read failed parts again', async () => {
    const onRescan = vi.fn();
    render(TakeoutPartsTable, {
      parts: [
        takeoutPartFactory.build({
          id: 'bad',
          size: 5000,
          readStatus: TakeoutPartReadStatus.Error,
          readError: 'gzip CRC mismatch',
          readErrorOffset: 1234,
        }),
      ],
      onRescan,
    });

    const row = within(screen.getByTestId('part-bad'));
    expect(row.getByText('Error at byte 1,234 of 5,000')).toBeInTheDocument();
    expect(row.getByText('gzip CRC mismatch')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Read failed parts again' }));
    expect(onRescan).toHaveBeenCalledOnce();
  });

  it('offers no read-again button without a failed part or a handler', () => {
    const { unmount } = render(TakeoutPartsTable, {
      parts: [takeoutPartFactory.build({ readStatus: TakeoutPartReadStatus.Read })],
      onRescan: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: 'Read failed parts again' })).not.toBeInTheDocument();
    unmount();

    render(TakeoutPartsTable, { parts: [takeoutPartFactory.build({ readStatus: TakeoutPartReadStatus.Error })] });
    expect(screen.queryByRole('button', { name: 'Read failed parts again' })).not.toBeInTheDocument();
  });

  it('flags a zip part whose listing could not be read, with the error', () => {
    const part = takeoutPartFactory.build({ id: 'zip', fileName: 'takeout-20260101T000000Z-002.zip' });
    render(TakeoutPartsTable, {
      parts: [part],
      corruptParts: ['takeout-20260101T000000Z-002.zip: end of central directory not found'],
    });

    const row = within(screen.getByTestId('part-zip'));
    expect(row.getByText('This part could not be read')).toBeInTheDocument();
    expect(row.getByText('end of central directory not found')).toBeInTheDocument();
  });

  it('shows no read state for the index part', () => {
    render(TakeoutPartsTable, {
      parts: [takeoutPartFactory.build({ id: 'index', isIndex: true, readStatus: TakeoutPartReadStatus.NotRead })],
    });

    expect(within(screen.getByTestId('part-index')).queryByText('Not read yet')).not.toBeInTheDocument();
  });
});
