import {
  cancelTakeoutRun,
  createTakeoutRun,
  deleteTakeoutExport,
  deleteTakeoutExportArchives,
  rescanTakeoutExport,
  resolveTakeoutLargerVersion,
  resumeTakeoutRun,
  syncTakeouts,
  TakeoutCompleteness,
  TakeoutLargerVersionAction,
  TakeoutRunFileAction,
  TakeoutRunStatus,
  type TakeoutExportDto,
  type TakeoutLargerVersionDto,
  type TakeoutOverviewDto,
  type TakeoutRunDto,
} from '@immich/sdk';
import { modalManager, type ActionItem } from '@immich/ui';
import { mdiDeleteOutline, mdiPlay, mdiRefresh, mdiTrashCanOutline } from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';
import { handleError } from '$lib/utils/handle-error';

const ACTIVE_RUN_STATUSES = new Set<TakeoutRunStatus>([
  TakeoutRunStatus.Queued,
  TakeoutRunStatus.Scanning,
  TakeoutRunStatus.Planning,
  TakeoutRunStatus.Importing,
  TakeoutRunStatus.Finishing,
  TakeoutRunStatus.Cancelling,
]);

const RESUMABLE_RUN_STATUSES = new Set<TakeoutRunStatus>([TakeoutRunStatus.Failed, TakeoutRunStatus.Cancelled]);

export const takeoutRunActive = (status: TakeoutRunStatus): boolean => ACTIVE_RUN_STATUSES.has(status);

export const takeoutRunResumable = (status: TakeoutRunStatus): boolean => RESUMABLE_RUN_STATUSES.has(status);

// snake_case suffix used by the i18n keys, from the camelCase enum values.
const toSnake = (value: string): string => value.replaceAll(/[A-Z]/g, (m) => '_' + m.toLowerCase());

// The dynamic keys below all exist in en.json, but their template-literal type is wider than the key union.
type TranslationKey = Parameters<MessageFormatter>[0];

export const runStatusLabel = ($t: MessageFormatter, status: TakeoutRunStatus): string =>
  $t(`takeout_run_status_${status}`);

export const runFileActionLabel = ($t: MessageFormatter, action: TakeoutRunFileAction): string =>
  $t(`takeout_action_${toSnake(action)}` as unknown as TranslationKey);

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

export const handleRunImport = async (
  $t: MessageFormatter,
  exportId: string,
  importAnyway: boolean,
): Promise<TakeoutRunDto | undefined> => {
  try {
    return await createTakeoutRun({ id: exportId, takeoutRunCreateDto: { importAnyway } });
  } catch (error) {
    handleError(error, $t('errors.unable_to_start_takeout_run'));
  }
};

export const handleCancelRun = async ($t: MessageFormatter, runId: string): Promise<TakeoutRunDto | undefined> => {
  const confirmed = await modalManager.showDialog({
    title: $t('takeout_cancel_run'),
    prompt: $t('takeout_cancel_run'),
    confirmText: $t('takeout_cancel_run'),
  });
  if (!confirmed) {
    return;
  }

  try {
    return await cancelTakeoutRun({ id: runId });
  } catch (error) {
    handleError(error, $t('errors.unable_to_start_takeout_run'));
  }
};

export const handleResumeRun = async ($t: MessageFormatter, runId: string): Promise<TakeoutRunDto | undefined> => {
  try {
    return await resumeTakeoutRun({ id: runId });
  } catch (error) {
    handleError(error, $t('errors.unable_to_start_takeout_run'));
  }
};

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
    title: $t('takeout_rescan_failed_parts'),
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
