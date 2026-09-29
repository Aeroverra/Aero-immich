import { TakeoutRunPartStatus, TakeoutRunStatus, type TakeoutRunDto } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { takeoutRunFactory, takeoutRunPartStatsFactory } from '@test-data/factories/takeout-factory';
import RunPage from './+page.svelte';

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));

vi.mock('$lib/components/layouts/UserPageLayout.svelte', async () => {
  return await import('@test-data/mocks/UserPageLayout.mock.svelte');
});

vi.mock('@immich/ui', async (originalImport) => {
  const module = await originalImport<typeof import('@immich/ui')>();
  return {
    ...module,
    modalManager: { show: vi.fn(), showDialog: vi.fn() },
  };
});

const GiB = 2 ** 30;

const data = (run: TakeoutRunDto): ComponentProps<typeof RunPage>['data'] => ({
  error: undefined,
  asset: undefined,
  run,
  meta: { title: 'Run import' },
});

describe('Takeout run page', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getTakeoutRunFiles.mockResolvedValue({ items: [], total: 0, hasNextPage: false });
  });

  it('keeps the staged files of a failed run, with Resume and Discard', async () => {
    const run = takeoutRunFactory.build({
      status: TakeoutRunStatus.Failed,
      hasStaging: true,
      error: 'Not enough free space',
      readStats: { stagingBytes: 12 * GiB, stagingExpiresAt: '2026-10-05T10:00:00.000Z' },
    });
    const discarded = { ...run, status: TakeoutRunStatus.Cancelled, hasStaging: false };
    vi.mocked(modalManager.showDialog).mockResolvedValue(true);
    sdkMock.cancelTakeoutRun.mockResolvedValue(discarded);

    render(RunPage, { data: data(run) });

    expect(screen.getByTestId('takeout-staging-kept')).toHaveTextContent('12 GiB staged, removed on Oct 5, 2026');
    expect(screen.getByRole('button', { name: 'Resume run' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Discard staged files' }));

    expect(sdkMock.cancelTakeoutRun).toHaveBeenCalledExactlyOnceWith({ id: run.id });
    expect(screen.queryByTestId('takeout-staging-kept')).not.toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('resumes a run from the staging card', async () => {
    const run = takeoutRunFactory.build({ status: TakeoutRunStatus.Cancelled, hasStaging: true });
    sdkMock.resumeTakeoutRun.mockResolvedValue({ ...run, status: TakeoutRunStatus.Queued });

    render(RunPage, { data: data(run) });
    await userEvent.click(screen.getByRole('button', { name: 'Resume run' }));

    expect(sdkMock.resumeTakeoutRun).toHaveBeenCalledExactlyOnceWith({ id: run.id });
    expect(screen.getByText('Queued')).toBeInTheDocument();
  });

  it('points a superseded run to the newer one and offers no Resume', () => {
    const run = takeoutRunFactory.build({ status: TakeoutRunStatus.Cancelled, supersededBy: 'newer-run' });

    render(RunPage, { data: data(run) });

    expect(screen.getByText('Continued by a newer import')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/takeouts/runs/newer-run');
    expect(screen.queryByRole('button', { name: /Resume run/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard staged files' })).not.toBeInTheDocument();
  });

  it('offers only Resume for a failed run without staged files', () => {
    render(RunPage, { data: data(takeoutRunFactory.build({ status: TakeoutRunStatus.Failed })) });

    expect(screen.getByRole('button', { name: 'Resume run' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard staged files' })).not.toBeInTheDocument();
  });

  it('folds the archive reads of a completed run', async () => {
    const run = takeoutRunFactory.build({
      status: TakeoutRunStatus.Completed,
      readStats: {
        parts: [takeoutRunPartStatsFactory.build({ fileName: 'takeout-x-001.tgz', status: TakeoutRunPartStatus.Read })],
      },
    });

    render(RunPage, { data: data(run) });

    expect(screen.queryByText('takeout-x-001.tgz')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Archive reads' }));
    expect(screen.getByText('takeout-x-001.tgz')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resume run/ })).not.toBeInTheDocument();
  });

  it('shows the parts under the reading block while the run reads', () => {
    const run = takeoutRunFactory.build({
      status: TakeoutRunStatus.Reading,
      readStats: {
        parts: [
          takeoutRunPartStatsFactory.build({ fileName: 'takeout-x-001.tgz', status: TakeoutRunPartStatus.Reading }),
        ],
      },
    });

    render(RunPage, { data: data(run) });

    expect(screen.getByText('takeout-x-001.tgz')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive reads' })).not.toBeInTheDocument();
  });
});
