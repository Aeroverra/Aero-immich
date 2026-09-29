import {
  cancelTakeoutRun,
  createTakeoutRun,
  deleteTakeoutExport,
  deleteTakeoutExportArchives,
  isHttpError,
  pauseTakeoutRun,
  rescanTakeoutExport,
  resolveTakeoutLargerVersion,
  resumeTakeoutRun,
  syncTakeouts,
  TakeoutCompleteness,
  TakeoutExportReadStatus,
  TakeoutLargerVersionAction,
  TakeoutRunFileAction,
  TakeoutRunStatus,
  type TakeoutExportDto,
  type TakeoutLargerVersionDto,
  type TakeoutOverviewDto,
  type TakeoutPartReadStatus,
  TakeoutRunPartStatus,
  type TakeoutRunDto,
  type TakeoutRunPartStatsDto,
  type TakeoutSizeCheck,
} from '@immich/sdk';
import { modalManager, toastManager, type ActionItem } from '@immich/ui';
import { mdiDeleteOutline, mdiPlay, mdiRefresh, mdiTrashCanOutline } from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';
import { getByteUnitString } from '$lib/utils/byte-units';
import { getServerErrorMessage, handleError } from '$lib/utils/handle-error';

/** Statuses in which a run works: it can be paused */
const RUNNING_RUN_STATUSES = new Set<TakeoutRunStatus>([
  TakeoutRunStatus.Queued,
  TakeoutRunStatus.Reading,
  TakeoutRunStatus.Planning,
  TakeoutRunStatus.Fetching,
  TakeoutRunStatus.Importing,
  TakeoutRunStatus.Finishing,
]);

/** Statuses of a run that is not finished: running, paused or cancelling */
const ACTIVE_RUN_STATUSES = new Set<TakeoutRunStatus>([
  ...RUNNING_RUN_STATUSES,
  TakeoutRunStatus.Paused,
  TakeoutRunStatus.Cancelling,
]);

const STOPPED_RUN_STATUSES = new Set<TakeoutRunStatus>([TakeoutRunStatus.Failed, TakeoutRunStatus.Cancelled]);

/** How long the server keeps the staged files of a failed or cancelled run (single-pass design 5.3) */
const STAGING_TTL_MS = 7 * 24 * 3600 * 1000;

export const takeoutRunActive = (status: TakeoutRunStatus): boolean => ACTIVE_RUN_STATUSES.has(status);

/** A running run can be paused: reading stops at once, the other steps at their next safe point */
export const takeoutRunPausable = (status: TakeoutRunStatus): boolean => RUNNING_RUN_STATUSES.has(status);

export const takeoutRunPaused = (status: TakeoutRunStatus): boolean => status === TakeoutRunStatus.Paused;

/** The status that places a run in its phases: a paused run is in the status it was paused in */
export const runPhaseStatus = (run: Pick<TakeoutRunDto, 'status' | 'pausedFrom'>): TakeoutRunStatus =>
  run.status === TakeoutRunStatus.Paused ? (run.pausedFrom ?? TakeoutRunStatus.Queued) : run.status;

/** A failed or cancelled run can be resumed unless a newer run took over its staged files */
export const takeoutRunResumable = (run: Pick<TakeoutRunDto, 'status' | 'supersededBy'>): boolean =>
  STOPPED_RUN_STATUSES.has(run.status) && !run.supersededBy;

/** A failed or cancelled run that still holds staged files: Discard deletes them (the server's cancel endpoint) */
export const takeoutRunDiscardable = (run: Pick<TakeoutRunDto, 'status' | 'hasStaging' | 'supersededBy'>): boolean =>
  STOPPED_RUN_STATUSES.has(run.status) && run.hasStaging && !run.supersededBy;

/** When the staged files of a stopped run are removed: the server's date, else its rule (finishedAt + 7 days) */
export const stagingExpiresAt = (run: Pick<TakeoutRunDto, 'readStats' | 'finishedAt'>): string | null => {
  if (run.readStats.stagingExpiresAt) {
    return run.readStats.stagingExpiresAt;
  }
  return run.finishedAt ? new Date(Date.parse(run.finishedAt) + STAGING_TTL_MS).toISOString() : null;
};

export type TakeoutRunPhase =
  | TakeoutRunStatus.Reading
  | TakeoutRunStatus.Planning
  | TakeoutRunStatus.Fetching
  | TakeoutRunStatus.Importing
  | TakeoutRunStatus.Finishing;

/** The phases of a run in order; fetching only when the run fetches (or fetched) files again */
export const runPhases = (run: Pick<TakeoutRunDto, 'status' | 'pausedFrom' | 'readStats'>): TakeoutRunPhase[] => {
  const fetching = runPhaseStatus(run) === TakeoutRunStatus.Fetching || run.readStats.fetchFiles > 0;
  return [
    TakeoutRunStatus.Reading,
    TakeoutRunStatus.Planning,
    ...(fetching ? [TakeoutRunStatus.Fetching as const] : []),
    TakeoutRunStatus.Importing,
    TakeoutRunStatus.Finishing,
  ];
};

/**
 * Index of the current phase in `phases`: every phase before it is done. -1 lights no phase (queued, and stopped
 * runs, whose last phase is not known); phases.length lights all of them (completed). A paused run lights the phase
 * it was paused in.
 */
export const runPhaseIndex = (run: Pick<TakeoutRunDto, 'status' | 'pausedFrom'>, phases: TakeoutRunPhase[]): number => {
  if (run.status === TakeoutRunStatus.Completed) {
    return phases.length;
  }
  return phases.indexOf(runPhaseStatus(run) as TakeoutRunPhase);
};

export const runPhaseLabel = ($t: MessageFormatter, phase: TakeoutRunPhase): string => {
  switch (phase) {
    case TakeoutRunStatus.Reading: {
      return $t('takeout_phase_reading');
    }
    case TakeoutRunStatus.Planning: {
      return $t('takeout_phase_planning');
    }
    case TakeoutRunStatus.Fetching: {
      return $t('takeout_phase_fetching');
    }
    case TakeoutRunStatus.Importing: {
      return $t('takeout_phase_creating');
    }
    case TakeoutRunStatus.Finishing: {
      return $t('takeout_phase_finishing');
    }
  }
};

export const progressFraction = (done: number, total: number): number =>
  total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;

export interface TakeoutRunMainProgress {
  phase: TakeoutRunPhase;
  done: number;
  total: number;
}

/** The byte bar that measures the current phase: archive bytes, fetch bytes or media bytes; none for the others */
export const runMainProgress = (
  run: Pick<
    TakeoutRunDto,
    'status' | 'pausedFrom' | 'readStats' | 'archiveBytesRead' | 'archiveBytesTotal' | 'bytesDone' | 'bytesTotal'
  >,
): TakeoutRunMainProgress | undefined => {
  const phase = runPhaseStatus(run);
  switch (phase) {
    case TakeoutRunStatus.Reading: {
      return { phase, done: run.archiveBytesRead, total: run.archiveBytesTotal };
    }
    case TakeoutRunStatus.Fetching: {
      return { phase, done: run.readStats.fetchBytesRead, total: run.readStats.fetchBytesTotal };
    }
    case TakeoutRunStatus.Importing: {
      return { phase, done: run.bytesDone, total: run.bytesTotal };
    }
    default: {
      return undefined;
    }
  }
};

// snake_case suffix used by the i18n keys, from the camelCase enum values.
const toSnake = (value: string): string => value.replaceAll(/[A-Z]/g, (m) => '_' + m.toLowerCase());

// The dynamic keys below all exist in en.json, but their template-literal type is wider than the key union.
type TranslationKey = Parameters<MessageFormatter>[0];

export const runStatusLabel = ($t: MessageFormatter, status: TakeoutRunStatus): string =>
  $t(`takeout_run_status_${status}`);

export const runFileActionLabel = ($t: MessageFormatter, action: TakeoutRunFileAction): string =>
  $t(`takeout_action_${toSnake(action)}` as unknown as TranslationKey);

/** Read state of a part of an export (parts table) */
export const partReadStatusLabel = ($t: MessageFormatter, status: TakeoutPartReadStatus): string =>
  $t(`takeout_part_status_${toSnake(status)}` as unknown as TranslationKey);

/** State of a part inside one run (run parts table) */
export const runPartStatusLabel = ($t: MessageFormatter, status: TakeoutRunPartStatus): string =>
  $t(`takeout_run_part_status_${status}`);

export const sizeCheckLabel = ($t: MessageFormatter, sizeCheck: TakeoutSizeCheck): string =>
  $t(`takeout_size_check_${sizeCheck}`);

/** "Error at byte N of M" when the offset is known, else the plain error state */
export const readErrorLabel = ($t: MessageFormatter, offset: number | null, size: number): string =>
  offset === null ? $t('takeout_part_status_error') : $t('takeout_error_at_byte', { values: { offset, size } });

// analysis reasons are stable snake_case keys straight from the server
export const analysisReasonLabel = ($t: MessageFormatter, reason: string): string =>
  $t(`takeout_reason_${reason}` as unknown as TranslationKey);

export const counterGroupLabel = ($t: MessageFormatter, group: string): string =>
  $t(`takeout_counter_group_${group}` as unknown as TranslationKey);

export const completenessColor = (
  completeness: TakeoutCompleteness,
): 'success' | 'warning' | 'danger' | 'secondary' => {
  switch (completeness) {
    case TakeoutCompleteness.Complete: {
      return 'success';
    }
    case TakeoutCompleteness.Uncertain: {
      return 'warning';
    }
    case TakeoutCompleteness.Incomplete: {
      return 'danger';
    }
    default: {
      return 'secondary';
    }
  }
};

export const completenessLabel = ($t: MessageFormatter, completeness: TakeoutCompleteness): string => {
  switch (completeness) {
    case TakeoutCompleteness.Complete: {
      return $t('takeout_complete');
    }
    case TakeoutCompleteness.Uncertain: {
      return $t('takeout_uncertain');
    }
    case TakeoutCompleteness.Incomplete: {
      return $t('takeout_incomplete');
    }
    default: {
      return $t('unknown');
    }
  }
};

/** The cheap pre-run checks (numbering, index, zip listings) have not run yet for an export that has its archives */
export const takeoutExportChecking = (exp: Pick<TakeoutExportDto, 'completeness' | 'archivesDeletedAt'>): boolean =>
  exp.completeness === TakeoutCompleteness.Unknown && !exp.archivesDeletedAt;

// The list of counter fields shown in the run counter grid, grouped as in TakeoutCountersDto.
export const counterGroups = {
  scanned: [
    'files',
    'images',
    'videos',
    'assetJsons',
    'albumJsons',
    'unknownJsons',
    'useless',
    'unsupported',
    'banned',
    'sidecars',
  ],
  matched: ['fastTrack', 'normal', 'forgottenDuplicates', 'edited', 'missingMetadata'],
  discarded: [
    'localDuplicates',
    'duplicatedInDirectory',
    'filteredPartner',
    'filteredTrashed',
    'filteredArchived',
    'filteredDateRange',
    'notSelected',
    'rotateOnlyDropped',
    'failedVideos',
    'previouslyDeleted',
    'unreadable',
    'missingFromArchive',
  ],
  result: [
    'toUpload',
    'uploaded',
    'serverDuplicates',
    'betterOnServer',
    'alreadyProcessed',
    'largerUploaded',
    'stacked',
    'albumsCreated',
    'albumAdds',
    'tagged',
    'metadataSaved',
    'rotationsQueued',
    'rotationsApplied',
    'zoneAssumed',
    'errors',
  ],
} as const;

export const counterLabel = ($t: MessageFormatter, field: string): string =>
  $t(`takeout_counter_${toSnake(field)}` as unknown as TranslationKey);

export const handleSyncTakeouts = async (): Promise<TakeoutOverviewDto | undefined> => {
  try {
    return await syncTakeouts();
  } catch (error) {
    const { getFormatter } = await import('$lib/utils/i18n');
    const $t = await getFormatter();
    handleError(error, $t('errors.unable_to_load_takeouts'));
  }
};

/**
 * The 409 refusals of Run that need a full sentence: the generic error toast cuts server messages at 75 characters,
 * which drops the count of half-imported files.
 */
export const runConflictMessage = ($t: MessageFormatter, error: unknown): string | undefined => {
  if (!isHttpError(error) || error.status !== 409) {
    return;
  }
  const message = getServerErrorMessage(error) ?? '';
  if (message.includes('still being copied')) {
    return $t('takeout_part_still_copying');
  }
  const halfImported = /(\d+) files? of it (?:is|are) half imported/.exec(message);
  if (halfImported) {
    return $t('takeout_previous_run_half_imported', { values: { count: Number(halfImported[1]) } });
  }
};

export const handleRunImport = async (
  $t: MessageFormatter,
  exportId: string,
  importAnyway: boolean,
): Promise<TakeoutRunDto | undefined> => {
  try {
    return await createTakeoutRun({ id: exportId, takeoutRunCreateDto: { importAnyway } });
  } catch (error) {
    const conflict = runConflictMessage($t, error);
    if (conflict) {
      toastManager.danger(conflict);
      return;
    }
    handleError(error, $t('errors.unable_to_start_takeout_run'));
  }
};

/** Cancel keeps the files staged so far (single-pass design 10.1); the dialog says so when there are any */
export const handleCancelRun = async (
  $t: MessageFormatter,
  run: Pick<TakeoutRunDto, 'id' | 'readStats'>,
  locale?: string,
): Promise<TakeoutRunDto | undefined> => {
  const stagedBytes = run.readStats.stagedBytes;
  const confirmed = await modalManager.showDialog({
    title: $t('takeout_cancel_run'),
    prompt:
      stagedBytes > 0
        ? $t('takeout_cancel_keeps_staging', { values: { size: getByteUnitString(stagedBytes, locale) } })
        : $t('takeout_cancel_run_description'),
    confirmText: $t('takeout_cancel_run'),
  });
  if (!confirmed) {
    return;
  }

  try {
    return await cancelTakeoutRun({ id: run.id });
  } catch (error) {
    handleError(error, $t('errors.unable_to_start_takeout_run'));
  }
};

/** Discard: on a failed or cancelled run the server's cancel endpoint deletes the staged files */
export const handleDiscardStaging = async (
  $t: MessageFormatter,
  run: Pick<TakeoutRunDto, 'id' | 'readStats'>,
  locale?: string,
): Promise<TakeoutRunDto | undefined> => {
  const confirmed = await modalManager.showDialog({
    title: $t('takeout_discard_staging'),
    prompt: $t('takeout_discard_staging_description', {
      values: { size: getByteUnitString(run.readStats.stagingBytes, locale) },
    }),
    confirmText: $t('takeout_discard_staging'),
  });
  if (!confirmed) {
    return;
  }

  try {
    return await cancelTakeoutRun({ id: run.id });
  } catch (error) {
    handleError(error, $t('errors.unable_to_start_takeout_run'));
  }
};

/** Resume a paused run where it waits, or a failed or cancelled run from where it stopped */
export const handleResumeRun = async ($t: MessageFormatter, runId: string): Promise<TakeoutRunDto | undefined> => {
  try {
    return await resumeTakeoutRun({ id: runId });
  } catch (error) {
    handleError(error, $t('errors.unable_to_resume_takeout_run'));
  }
};

/** Pause a running run: nothing is read twice, and it stays paused (also across a server restart) until resumed */
export const handlePauseRun = async ($t: MessageFormatter, runId: string): Promise<TakeoutRunDto | undefined> => {
  try {
    return await pauseTakeoutRun({ id: runId });
  } catch (error) {
    handleError(error, $t('errors.unable_to_pause_takeout_run'));
  }
};

/**
 * Seconds a part spent reading: from its start to its end (or now), without the time it was paused. A part paused now
 * stops counting at the start of the pause when it is known (the run's pausedAt).
 */
export const partReadSeconds = (
  part: Pick<TakeoutRunPartStatsDto, 'startedAt' | 'finishedAt' | 'pausedMs' | 'status'>,
  pausedAt: string | null,
  now = Date.now(),
): number | undefined => {
  if (!part.startedAt) {
    return undefined;
  }
  let end = part.finishedAt ? Date.parse(part.finishedAt) : now;
  if (!part.finishedAt && part.status === TakeoutRunPartStatus.Paused && pausedAt) {
    end = Math.min(end, Date.parse(pausedAt));
  }
  const seconds = (end - Date.parse(part.startedAt) - part.pausedMs) / 1000;
  return seconds > 0 ? seconds : undefined;
};

/** "Read failed parts again": parts in error go back to not read, the next run reads them */
export const handleRescanExport = async ($t: MessageFormatter, exportId: string) => {
  try {
    return await rescanTakeoutExport({ id: exportId });
  } catch (error) {
    handleError(error, $t('errors.unable_to_load_takeouts'));
  }
};

export const handleDeleteExportArchives = async ($t: MessageFormatter, exportId: string): Promise<boolean> => {
  const confirmed = await modalManager.showDialog({
    title: $t('takeout_delete_archives'),
    prompt: $t('takeout_delete_archives_description'),
    confirmText: $t('delete'),
  });
  if (!confirmed) {
    return false;
  }

  try {
    await deleteTakeoutExportArchives({ id: exportId });
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_load_takeouts'));
    return false;
  }
};

export const handleDeleteExport = async ($t: MessageFormatter, exportId: string): Promise<boolean> => {
  try {
    await deleteTakeoutExport({ id: exportId });
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_load_takeouts'));
    return false;
  }
};

export const handleResolveLargerVersion = async (
  $t: MessageFormatter,
  id: string,
  action: TakeoutLargerVersionAction,
): Promise<TakeoutLargerVersionDto | undefined> => {
  try {
    return await resolveTakeoutLargerVersion({ id, takeoutLargerVersionResolveDto: { action } });
  } catch (error) {
    handleError(error, $t('errors.unable_to_resolve_larger_version'));
  }
};

export const getTakeoutExportActions = ($t: MessageFormatter, exp: TakeoutExportDto) => {
  const complete = exp.completeness === TakeoutCompleteness.Complete;
  const hasActiveRun = !!exp.lastRun && takeoutRunActive(exp.lastRun.status);

  const RunImport: ActionItem = {
    icon: mdiPlay,
    title: $t('takeout_run_import'),
    $if: () => complete && !hasActiveRun,
    onAction: () => handleRunImport($t, exp.id, false),
  };

  const ImportAnyway: ActionItem = {
    icon: mdiPlay,
    title: $t('takeout_import_anyway'),
    $if: () => !complete && !hasActiveRun,
    onAction: () => handleRunImport($t, exp.id, true),
  };

  const Rescan: ActionItem = {
    icon: mdiRefresh,
    title: $t('takeout_read_failed_parts_again'),
    $if: () => exp.readStatus === TakeoutExportReadStatus.Error && !hasActiveRun,
    onAction: () => handleRescanExport($t, exp.id),
  };

  const DeleteArchives: ActionItem = {
    icon: mdiTrashCanOutline,
    color: 'danger',
    title: $t('takeout_delete_archives'),
    $if: () => !exp.archivesDeletedAt,
    onAction: () => handleDeleteExportArchives($t, exp.id),
  };

  const Dismiss: ActionItem = {
    icon: mdiDeleteOutline,
    color: 'danger',
    title: $t('delete'),
    $if: () => !!exp.archivesDeletedAt,
    onAction: () => handleDeleteExport($t, exp.id),
  };

  return { RunImport, ImportAnyway, Rescan, DeleteArchives, Dismiss };
};
