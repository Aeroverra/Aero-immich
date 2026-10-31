import { TakeoutSizeCheck } from '@immich/sdk';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import TakeoutAnalysisPanel from '$lib/components/takeouts/TakeoutAnalysisPanel.svelte';
import { takeoutAnalysisFactory } from '@test-data/factories/takeout-factory';

const GB = 10 ** 9;

const beforeImport = () => within(screen.getByRole('region', { name: 'Before import' }));
const fromLastImport = () => within(screen.getByRole('region', { name: 'From the last import' }));

describe('TakeoutAnalysisPanel component', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  it('shows the checks made before any read', () => {
    render(TakeoutAnalysisPanel, {
      analysis: takeoutAnalysisFactory.build({
        sizeCheck: TakeoutSizeCheck.Ok,
        indexTotalBytes: 784.5 * GB,
        partsTotalBytes: 785 * GB,
      }),
    });

    expect(beforeImport().getByText('Part numbering has no gaps')).toBeInTheDocument();
    expect(beforeImport().getByText('The parts match the size the index announces')).toBeInTheDocument();
    expect(beforeImport().getByText('The parts hold 731.09 GiB, the index announces 730.62 GiB')).toBeInTheDocument();
    expect(
      fromLastImport().getByText('The JSON and index checks run while the next import reads the archives.'),
    ).toBeInTheDocument();
  });

  it('shows numbering gaps, a short size, unstable parts and zip listing results', async () => {
    render(TakeoutAnalysisPanel, {
      analysis: takeoutAnalysisFactory.build({
        missingParts: [{ segment: null, partNumber: 3, expectedName: 'takeout-20260101T000000Z-003.zip' }],
        sizeCheck: TakeoutSizeCheck.Short,
        indexTotalBytes: 100 * GB,
        partsTotalBytes: 50 * GB,
        listingChecked: true,
        indexMissingFiles: { count: 2, sample: ['Takeout/Google Photos/a.jpg', 'Takeout/Google Photos/b.jpg'] },
        reasons: ['missing_part', 'size_shortfall', 'index_missing_files', 'part_unstable'],
      }),
    });

    const before = beforeImport();
    expect(before.getByText('1 part is missing from the numbering')).toBeInTheDocument();
    expect(before.getByText('takeout-20260101T000000Z-003.zip')).toBeInTheDocument();
    expect(before.getByText('The parts are much smaller than the index announces')).toBeInTheDocument();
    expect(before.getByText('Zip listings checked against the index')).toBeInTheDocument();
    expect(before.getByText('A part is still being copied')).toBeInTheDocument();

    await userEvent.click(before.getByRole('button', { name: /2 files in the index are missing/ }));
    expect(before.getByText('Takeout/Google Photos/a.jpg')).toBeInTheDocument();
  });

  it('says when there is no index to compare the size with', () => {
    render(TakeoutAnalysisPanel, { analysis: takeoutAnalysisFactory.build() });

    expect(beforeImport().getByText('No index archive to compare the size with')).toBeInTheDocument();
  });

  it('shows what the last import found', () => {
    render(TakeoutAnalysisPanel, {
      analysis: takeoutAnalysisFactory.build({
        lastReadAt: '2026-09-28T12:00:00.000Z',
        lastReadRunId: 'run-1',
        unreadableParts: [
          { fileName: 'takeout-20260101T000000Z-002.tgz', error: 'unexpected end of file', offset: 1234, size: 5000 },
        ],
        unreadableEntries: 3,
        jsonWithoutMedia: { count: 1, sample: ['Takeout/Google Photos/x.jpg.json'] },
        indexMissingFiles: { count: 4, sample: [] },
        reasons: ['part_unreadable', 'orphan_json', 'index_missing_files'],
      }),
    });

    const last = fromLastImport();
    expect(last.getByRole('link', { name: /Checked by the import of/ })).toHaveAttribute(
      'href',
      '/takeouts/runs/run-1',
    );
    expect(last.getByText('takeout-20260101T000000Z-002.tgz: Error at byte 1,234 of 5,000')).toBeInTheDocument();
    expect(last.getByText('unexpected end of file')).toBeInTheDocument();
    expect(last.getByText('3 files in zip parts could not be read')).toBeInTheDocument();
    expect(last.getByText('1 Google JSON without media')).toBeInTheDocument();
    expect(last.getByText('4 files in the index are missing from the parts')).toBeInTheDocument();
    expect(beforeImport().queryByText(/files in the index are missing/)).not.toBeInTheDocument();
  });
});
