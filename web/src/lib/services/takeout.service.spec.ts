import {
  TakeoutCompleteness,
  TakeoutPartReadStatus,
  TakeoutRunFileAction,
  TakeoutRunPartStatus,
  TakeoutRunStatus,
  TakeoutSizeCheck,
} from '@immich/sdk';
import { modalManager, toastManager } from '@immich/ui';
import { init, register, t, waitLocale, type MessageFormatter } from 'svelte-i18n';
import { get } from 'svelte/store';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import {
  counterGroups,
  handleCancelRun,
  handleDiscardStaging,
  handleRunImport,
  partReadStatusLabel,
  readErrorLabel,
  runFileActionLabel,
  runMainProgress,
  runPartStatusLabel,
  runPhaseIndex,
  runPhaseLabel,
  runPhases,
  runStatusLabel,
  sizeCheckLabel,
  stagingExpiresAt,
  takeoutExportChecking,
  takeoutRunActive,
  takeoutRunDiscardable,
  takeoutRunResumable,
} from '$lib/services/takeout.service';
import { takeoutExportFactory, takeoutRunFactory } from '@test-data/factories/takeout-factory';

vi.mock('@immich/ui', async (originalImport) => {
  const module = await originalImport<typeof import('@immich/ui')>();
  return {
    ...module,
    modalManager: { show: vi.fn(), showDialog: vi.fn() },
    toastManager: { primary: vi.fn(), danger: vi.fn() },
  };
});

const keys = new Set(Object.keys(en));
const toSnake = (value: string) => value.replaceAll(/[A-Z]/g, (m) => '_' + m.toLowerCase());

// the reasons the server's analyzeExport can emit (server/src/takeout/types.ts ANALYSIS_REASONS)
const ANALYSIS_REASONS = [
  'missing_part',
  'part_missing_on_disk',
  'corrupt_part',
  'part_unstable',
  'part_unreadable',
  'size_shortfall',
  'index_missing_files',
  'orphan_json',
  'last_part_may_be_missing',
];

describe('takeout service', () => {
  let $t: MessageFormatter;

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    $t = get(t);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('run states', () => {
    it.each([
      TakeoutRunStatus.Queued,
      TakeoutRunStatus.Reading,
      TakeoutRunStatus.Planning,
      TakeoutRunStatus.Fetching,
      TakeoutRunStatus.Importing,
      TakeoutRunStatus.Finishing,
      TakeoutRunStatus.Cancelling,
    ])('treats %s as active', (status) => {
      expect(takeoutRunActive(status)).toBe(true);
    });

    it.each([TakeoutRunStatus.Completed, TakeoutRunStatus.Failed, TakeoutRunStatus.Cancelled])(
      'treats %s as not active',
      (status) => {
        expect(takeoutRunActive(status)).toBe(false);
      },
    );

    it('has no scanning status any more', () => {
      expect(Object.values(TakeoutRunStatus)).not.toContain('scanning');
    });

    it.each([
      { status: TakeoutRunStatus.Failed, supersededBy: null, expected: true },
      { status: TakeoutRunStatus.Cancelled, supersededBy: null, expected: true },
      { status: TakeoutRunStatus.Cancelled, supersededBy: 'newer', expected: false },
      { status: TakeoutRunStatus.Completed, supersededBy: null, expected: false },
      { status: TakeoutRunStatus.Reading, supersededBy: null, expected: false },
    ])('resumable: $status superseded by $supersededBy -> $expected', ({ status, supersededBy, expected }) => {
      expect(takeoutRunResumable(takeoutRunFactory.build({ status, supersededBy }))).toBe(expected);
    });

    it.each([
      { status: TakeoutRunStatus.Failed, hasStaging: true, supersededBy: null, expected: true },
      { status: TakeoutRunStatus.Cancelled, hasStaging: true, supersededBy: null, expected: true },
      { status: TakeoutRunStatus.Failed, hasStaging: false, supersededBy: null, expected: false },
      { status: TakeoutRunStatus.Cancelled, hasStaging: false, supersededBy: null, expected: false },
      { status: TakeoutRunStatus.Cancelled, hasStaging: true, supersededBy: 'newer', expected: false },
      { status: TakeoutRunStatus.Reading, hasStaging: true, supersededBy: null, expected: false },
      { status: TakeoutRunStatus.Completed, hasStaging: true, supersededBy: null, expected: false },
    ])(
      'discardable: $status with staging $hasStaging superseded by $supersededBy -> $expected',
      ({ status, hasStaging, supersededBy, expected }) => {
        expect(takeoutRunDiscardable(takeoutRunFactory.build({ status, hasStaging, supersededBy }))).toBe(expected);
      },
    );

    it('takes the staging expiry from the server, else finishedAt plus 7 days', () => {
      expect(
        stagingExpiresAt(
          takeoutRunFactory.build({
            finishedAt: '2026-09-01T00:00:00.000Z',
            readStats: { stagingExpiresAt: '2026-09-05T00:00:00.000Z' },
          }),
        ),
      ).toBe('2026-09-05T00:00:00.000Z');
      expect(stagingExpiresAt(takeoutRunFactory.build({ finishedAt: '2026-09-01T00:00:00.000Z' }))).toBe(
        '2026-09-08T00:00:00.000Z',
      );
      expect(stagingExpiresAt(takeoutRunFactory.build())).toBeNull();
    });

    it('says the pre-run checks are running while the completeness is unknown and the archives exist', () => {
      expect(takeoutExportChecking(takeoutExportFactory.build({ completeness: TakeoutCompleteness.Unknown }))).toBe(
        true,
      );
      expect(
        takeoutExportChecking(
          takeoutExportFactory.build({
            completeness: TakeoutCompleteness.Unknown,
            archivesDeletedAt: '2026-09-01T00:00:00.000Z',
          }),
        ),
      ).toBe(false);
      expect(takeoutExportChecking(takeoutExportFactory.build({ completeness: TakeoutCompleteness.Uncertain }))).toBe(
        false,
      );
    });
  });

  describe('phases', () => {
    it('reads, plans, creates assets and finishes when nothing is fetched', () => {
      const run = takeoutRunFactory.build({ status: TakeoutRunStatus.Reading });
      expect(runPhases(run)).toEqual([
        TakeoutRunStatus.Reading,
        TakeoutRunStatus.Planning,
        TakeoutRunStatus.Importing,
        TakeoutRunStatus.Finishing,
      ]);
    });

    it('adds fetching while the run fetches', () => {
      const run = takeoutRunFactory.build({ status: TakeoutRunStatus.Fetching });
      expect(runPhases(run)).toEqual([
        TakeoutRunStatus.Reading,
        TakeoutRunStatus.Planning,
        TakeoutRunStatus.Fetching,
        TakeoutRunStatus.Importing,
        TakeoutRunStatus.Finishing,
      ]);
    });

    it('keeps fetching once the run fetched files', () => {
      const run = takeoutRunFactory.build({ status: TakeoutRunStatus.Completed, readStats: { fetchFiles: 2 } });
      expect(runPhases(run)).toContain(TakeoutRunStatus.Fetching);
    });

    it.each([
      { status: TakeoutRunStatus.Queued, expected: -1 },
      { status: TakeoutRunStatus.Reading, expected: 0 },
      { status: TakeoutRunStatus.Planning, expected: 1 },
      { status: TakeoutRunStatus.Importing, expected: 2 },
      { status: TakeoutRunStatus.Finishing, expected: 3 },
      { status: TakeoutRunStatus.Completed, expected: 4 },
      { status: TakeoutRunStatus.Failed, expected: -1 },
      { status: TakeoutRunStatus.Cancelling, expected: -1 },
    ])('puts $status at phase $expected', ({ status, expected }) => {
      const run = takeoutRunFactory.build({ status });
      expect(runPhaseIndex(run, runPhases(run))).toBe(expected);
    });

    it('labels the phases, importing as Creating assets', () => {
      const run = takeoutRunFactory.build({ status: TakeoutRunStatus.Fetching });
      expect(runPhases(run).map((phase) => runPhaseLabel($t, phase))).toEqual([
        'Reading',
        'Planning',
        'Fetching',
        'Creating assets',
        'Finishing',
      ]);
    });

    it('measures each phase with its own bytes', () => {
      const base = {
        archiveBytesRead: 10,
        archiveBytesTotal: 100,
        bytesDone: 30,
        bytesTotal: 300,
        readStats: { fetchBytesRead: 20, fetchBytesTotal: 200 },
      };
      expect(runMainProgress(takeoutRunFactory.build({ ...base, status: TakeoutRunStatus.Reading }))).toEqual({
        phase: TakeoutRunStatus.Reading,
        done: 10,
        total: 100,
      });
      expect(runMainProgress(takeoutRunFactory.build({ ...base, status: TakeoutRunStatus.Fetching }))).toEqual({
        phase: TakeoutRunStatus.Fetching,
        done: 20,
        total: 200,
      });
      expect(runMainProgress(takeoutRunFactory.build({ ...base, status: TakeoutRunStatus.Importing }))).toEqual({
        phase: TakeoutRunStatus.Importing,
        done: 30,
        total: 300,
      });
      expect(runMainProgress(takeoutRunFactory.build({ ...base, status: TakeoutRunStatus.Planning }))).toBeUndefined();
    });
  });

  describe('labels', () => {
    it.each(Object.values(TakeoutRunStatus))('has a label for run status %s', (status) => {
      expect(keys).toContain(`takeout_run_status_${status}`);
      expect(runStatusLabel($t, status)).not.toContain('takeout_');
    });

    it.each(Object.values(TakeoutRunFileAction))('has a label for report action %s', (action) => {
      expect(keys).toContain(`takeout_action_${toSnake(action)}`);
      expect(runFileActionLabel($t, action)).not.toContain('takeout_');
    });

    it.each(Object.values(TakeoutPartReadStatus))('has a label for part read status %s', (status) => {
      expect(keys).toContain(`takeout_part_status_${toSnake(status)}`);
    });

    it.each(Object.values(TakeoutRunPartStatus))('has a label for run part status %s', (status) => {
      expect(keys).toContain(`takeout_run_part_status_${status}`);
    });

    it.each(Object.values(TakeoutSizeCheck))('has a label for size check %s', (sizeCheck) => {
      expect(sizeCheckLabel($t, sizeCheck)).not.toContain('takeout_');
    });

    it.each(ANALYSIS_REASONS)('has a label for analysis reason %s', (reason) => {
      expect(keys).toContain(`takeout_reason_${reason}`);
    });

    it('has a label for every counter, including the unreadable and missing-from-archive discards', () => {
      expect(counterGroups.discarded).toContain('unreadable');
      expect(counterGroups.discarded).toContain('missingFromArchive');
      for (const [group, fields] of Object.entries(counterGroups)) {
        expect(keys).toContain(`takeout_counter_group_${group}`);
        for (const field of fields) {
          expect(keys).toContain(`takeout_counter_${toSnake(field)}`);
        }
      }
    });

    it('drops the scan wording', () => {
      for (const key of [
        'takeout_scanning',
        'takeout_scans_waiting',
        'takeout_phase_scanning',
        'takeout_run_status_scanning',
        'takeout_rescan_failed_parts',
        'takeout_reason_not_scanned',
      ]) {
        expect(keys).not.toContain(key);
      }
    });

    it('labels part states', () => {
      expect(partReadStatusLabel($t, TakeoutPartReadStatus.NotRead)).toBe('Not read yet');
      expect(partReadStatusLabel($t, TakeoutPartReadStatus.Partial)).toBe('Partly read');
      expect(runPartStatusLabel($t, TakeoutRunPartStatus.Cached)).toBe('Read earlier');
    });

    it('places a read error when the offset is known', () => {
      expect(readErrorLabel($t, 1234, 5000)).toBe('Error at byte 1,234 of 5,000');
      expect(readErrorLabel($t, null, 5000)).toBe('Error');
    });
  });

  describe('actions', () => {
    it('warns that a cancel keeps the staged files', async () => {
      const run = takeoutRunFactory.build({
        status: TakeoutRunStatus.Reading,
        readStats: { stagedBytes: 3 * 2 ** 30 },
      });
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);
      sdkMock.cancelTakeoutRun.mockResolvedValue(run);

      await expect(handleCancelRun($t, run, 'en-US')).resolves.toBe(run);

      expect(modalManager.showDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt:
            'Files staged so far (3 GiB) are kept for 7 days so a new import does not read the archives again. Discard deletes them now.',
        }),
      );
      expect(sdkMock.cancelTakeoutRun).toHaveBeenCalledExactlyOnceWith({ id: run.id });
    });

    it('asks plainly when nothing is staged yet', async () => {
      const run = takeoutRunFactory.build({ status: TakeoutRunStatus.Queued });
      vi.mocked(modalManager.showDialog).mockResolvedValue(false);

      await expect(handleCancelRun($t, run)).resolves.toBeUndefined();

      expect(modalManager.showDialog).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'Stop this import. Assets it already created stay in your library.' }),
      );
      expect(sdkMock.cancelTakeoutRun).not.toHaveBeenCalled();
    });

    it('discards staged files through the cancel endpoint after a confirmation', async () => {
      const run = takeoutRunFactory.build({
        status: TakeoutRunStatus.Failed,
        hasStaging: true,
        readStats: { stagingBytes: 2 ** 30 },
      });
      const discarded = { ...run, status: TakeoutRunStatus.Cancelled, hasStaging: false };
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);
      sdkMock.cancelTakeoutRun.mockResolvedValue(discarded);

      await expect(handleDiscardStaging($t, run, 'en-US')).resolves.toBe(discarded);

      expect(modalManager.showDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Discard staged files',
          prompt:
            'Delete the files staged by this import now (1 GiB). A later import reads the archives again for them.',
        }),
      );
      expect(sdkMock.cancelTakeoutRun).toHaveBeenCalledExactlyOnceWith({ id: run.id });
    });

    it('does not discard without a confirmation', async () => {
      const run = takeoutRunFactory.build({ status: TakeoutRunStatus.Cancelled, hasStaging: true });
      vi.mocked(modalManager.showDialog).mockResolvedValue(false);

      await expect(handleDiscardStaging($t, run)).resolves.toBeUndefined();

      expect(sdkMock.cancelTakeoutRun).not.toHaveBeenCalled();
    });

    it('explains a Run refused for half-imported files of the previous import in full', async () => {
      sdkMock.isHttpError.mockReturnValue(true);
      sdkMock.createTakeoutRun.mockRejectedValue({
        status: 409,
        message: 'Conflict',
        data: { message: 'Resume or discard the previous import first: 12 files of it are half imported' },
      });

      await expect(handleRunImport($t, 'export-1', false)).resolves.toBeUndefined();

      expect(toastManager.danger).toHaveBeenCalledExactlyOnceWith(
        'Resume or discard the previous import first: 12 files of it are half imported.',
      );
    });

    it('explains a Run refused while a part is still being copied', async () => {
      sdkMock.isHttpError.mockReturnValue(true);
      sdkMock.createTakeoutRun.mockRejectedValue({
        status: 409,
        message: 'Conflict',
        data: { message: 'A part is still being copied' },
      });

      await handleRunImport($t, 'export-1', true);

      expect(toastManager.danger).toHaveBeenCalledExactlyOnceWith(
        'A part is still being copied. Try again when the copy is finished.',
      );
    });

    it('leaves other Run errors to the generic handler', async () => {
      sdkMock.isHttpError.mockReturnValue(true);
      sdkMock.createTakeoutRun.mockRejectedValue({
        status: 409,
        message: 'Conflict',
        data: { message: 'An import is already running' },
      });

      await handleRunImport($t, 'export-1', false);

      expect(toastManager.danger).toHaveBeenCalledExactlyOnceWith(
        'An import is already running\n(Immich Server Error)',
      );
    });
  });
});
