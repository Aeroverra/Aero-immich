import {
  getStack,
  searchStacks,
  StackActionMode,
  StackSource,
  updateMyPreferences,
  type StackResponseDto,
} from '@immich/sdk';
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
 * A collapsed stack only shows its primary asset, so an action on a selection with stacks has to decide whether it
 * applies to the stacked assets too. A manual stack (edited copies, Video Boost pairs, RAW and JPEG) is one item to the
 * user, so every action applies to all of it. An automatic stack groups different but similar photos, so the
 * stackActions preference decides for those, or the user is asked.
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

  let stacks: StackResponseDto[];
  try {
    stacks = await getStacks(stackIds);
  } catch (error) {
    const $t = await getFormatter();
    handleError(error, $t('errors.unable_to_load_stacked_assets'));
    return;
  }

  const manualStacks = stacks.filter(({ source }) => source !== StackSource.Auto);
  const autoStacks = stacks.filter(({ source }) => source === StackSource.Auto);

  let includeAutoStacks = false;
  if (autoStacks.length > 0) {
    includeAutoStacks = getMode() === StackActionMode.Stack;
    if (getMode() === StackActionMode.Ask) {
      const choice = (await modalManager.show(StackSelectionModal, { stackCount: autoStacks.length })) as
        StackSelectionChoice | undefined;
      if (!choice) {
        return;
      }

      includeAutoStacks = choice.includeStacked;
      if (choice.remember) {
        await rememberChoice(includeAutoStacks);
      }
    }
  }

  const result = new Set(ids);
  for (const stack of includeAutoStacks ? [...manualStacks, ...autoStacks] : manualStacks) {
    for (const asset of stack.assets) {
      result.add(asset.id);
    }
  }
  return [...result];
};

/**
 * The ids a single-asset action (the viewer's add to album or tag) applies to: the asset, and for a manual stack every
 * other asset of it too, since a manual stack is one item to the user. Automatic stacks and assets outside a stack are
 * acted on alone, and so is a stack that cannot be loaded, like a partner's.
 */
export const resolveAssetStackIds = async (asset: { id: string; stack?: { id: string } | null }): Promise<string[]> => {
  if (!asset.stack) {
    return [asset.id];
  }

  try {
    const stack = await getStack({ id: asset.stack.id });
    if (stack.source === StackSource.Auto) {
      return [asset.id];
    }
    return [asset.id, ...stack.assets.map(({ id }) => id).filter((id) => id !== asset.id)];
  } catch {
    return [asset.id];
  }
};

/** Like resolveStackSelection, for actions that keep working with the selected assets: only the added stacked ids */
export const resolveStackedAssetIds = async (assets: SelectionAsset[]): Promise<string[] | undefined> => {
  const ids = await resolveStackSelection(assets);
  return ids?.slice(assets.length);
};
