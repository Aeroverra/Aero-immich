import { getStack, searchStacks, StackActionMode, updateMyPreferences, type StackResponseDto } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import { authManager } from '$lib/managers/auth-manager.svelte';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import StackSelectionModal from '$lib/modals/StackSelectionModal.svelte';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

export type StackSelectionChoice = {
  includeStacked: boolean;
  remember: boolean;
};

type SelectionAsset = Pick<TimelineAsset, 'id' | 'stack'>;

/** above this many stacks, one search for all stacks of the user is cheaper than a request per stack */
const STACK_SEARCH_THRESHOLD = 20;

/** The stacks in a selection that hide assets behind their primary asset */
export const getCollapsedStackIds = (assets: SelectionAsset[]) => {
  const stackIds = new Set<string>();
  for (const { stack } of assets) {
    if (stack && stack.assetCount > 1) {
      stackIds.add(stack.id);
    }
  }
  return [...stackIds];
};

const getStacks = async (stackIds: string[]): Promise<StackResponseDto[]> => {
  if (stackIds.length > STACK_SEARCH_THRESHOLD) {
    const wanted = new Set(stackIds);
    const stacks = await searchStacks({});
    return stacks.filter(({ id }) => wanted.has(id));
  }

  // stacks of other users (partners) are not accessible, their primary asset is all that can be acted on
  const stacks = await Promise.all(stackIds.map((id) => getStack({ id }).catch(() => undefined)));
  return stacks.filter((stack) => stack !== undefined);
};

const getMode = () => authManager.preferences.stackActions?.mode ?? StackActionMode.Ask;

const rememberChoice = async (includeStacked: boolean) => {
  const mode = includeStacked ? StackActionMode.Stack : StackActionMode.Primary;
  try {
    const preferences = await updateMyPreferences({ userPreferencesUpdateDto: { stackActions: { mode } } });
    authManager.setPreferences(preferences);
  } catch (error) {
    const $t = await getFormatter();
    handleError(error, $t('errors.unable_to_update_settings'));
  }
};

/**
 * A collapsed stack only shows its primary asset, so an action on a selection with stacks either applies to those
 * primary assets or to every asset of the stacks. The stackActions preference decides, or the user is asked.
 *
 * Resolves to the ids the action applies to (the selected assets first, followed by the stacked assets that were not
 * selected), or to undefined when the user cancels.
 */
export const resolveStackSelection = async (assets: SelectionAsset[]): Promise<string[] | undefined> => {
  const ids = assets.map(({ id }) => id);
  const stackIds = getCollapsedStackIds(assets);
  if (stackIds.length === 0) {
    return ids;
  }

  let includeStacked = getMode() === StackActionMode.Stack;
  if (getMode() === StackActionMode.Ask) {
    const choice = (await modalManager.show(StackSelectionModal, { stackCount: stackIds.length })) as
      StackSelectionChoice | undefined;
    if (!choice) {
      return;
    }

    includeStacked = choice.includeStacked;
    if (choice.remember) {
      await rememberChoice(includeStacked);
    }
  }

  if (!includeStacked) {
    return ids;
  }

  try {
    const stacks = await getStacks(stackIds);
    const result = new Set(ids);
    for (const stack of stacks) {
      for (const asset of stack.assets) {
        result.add(asset.id);
      }
    }
    return [...result];
  } catch (error) {
    const $t = await getFormatter();
    handleError(error, $t('errors.unable_to_load_stacked_assets'));
  }
};

/** Like resolveStackSelection, for actions that keep working with the selected assets: only the added stacked ids */
export const resolveStackedAssetIds = async (assets: SelectionAsset[]): Promise<string[] | undefined> => {
  const ids = await resolveStackSelection(assets);
  return ids?.slice(assets.length);
};
