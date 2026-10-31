import {
  deleteTag,
  getAssetInfo,
  getCustomViews,
  updateTag,
  upsertTags,
  type TagResponseDto,
  type TagUpdateDto,
} from '@immich/sdk';
import { modalManager, toastManager, type ActionItem } from '@immich/ui';
import { mdiPencil, mdiPlus, mdiTrashCanOutline } from '@mdi/js';
import { type MessageFormatter } from 'svelte-i18n';
import { rememberRecentTags } from '$lib/components/tags/tag-picker.svelte';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
import { viewManager } from '$lib/managers/view-manager.svelte';
import TagCreateModal from '$lib/modals/TagCreateModal.svelte';
import TagEditModal from '$lib/modals/TagEditModal.svelte';
import { removeTag, tagAssets } from '$lib/utils/asset-utils';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';
import type { TreeNode } from '$lib/utils/tree-utils';
import { getViewDeparture } from '$lib/utils/view-departures';

export const getTagActions = ($t: MessageFormatter, tag: TreeNode) => {
  const Create: ActionItem = {
    title: $t('create_tag'),
    icon: mdiPlus,
    onAction: () => modalManager.show(TagCreateModal, { baseTag: tag }),
  };

  const Update: ActionItem = {
    title: $t('edit_tag'),
    icon: mdiPencil,
    $if: () => tag.path.length > 0,
    onAction: () => modalManager.show(TagEditModal, { tag }),
  };

  const Delete: ActionItem = {
    title: $t('delete_tag'),
    icon: mdiTrashCanOutline,
    $if: () => tag.path.length > 0,
    onAction: () => handleDeleteTag(tag),
  };

  return { Create, Update, Delete };
};

/** how many assets are looked up at once to find the ones a tag change took out of the view */
const VIEW_CHECK_CONCURRENCY = 6;

/** The assets of [assetIds] the session cannot read anymore, looked up one by one */
const findUnreadableAssets = async (assetIds: string[]) => {
  const unreadable: string[] = [];
  const queue = [...assetIds];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        await getAssetInfo({ id });
      } catch {
        unreadable.push(id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(VIEW_CHECK_CONCURRENCY, queue.length) }, worker));
  return unreadable;
};

/**
 * A tag change can take assets out of the view the session sees, like adding a tag the view excludes. Those assets
 * leave the selection, and what is on screen reloads the way it does when the view changes, so they disappear from the
 * page instead of staying behind as assets the server refuses to read.
 */
const removeAssetsLeavingView = async (
  assetIds: string[],
  tags: TagResponseDto[],
  changes: { addIds: string[]; removeIds: string[] },
) => {
  const departure = getViewDeparture(viewManager.active.view, tags, changes);
  if (departure === 'none') {
    return;
  }

  const changed = new Set(assetIds);
  const selected = assetMultiSelectManager.assets.filter(({ id }) => changed.has(id)).map(({ id }) => id);
  let leaving = departure === 'all' ? assetIds : [];
  if (departure === 'unknown') {
    try {
      leaving = await findUnreadableAssets(selected);
    } catch (error) {
      console.warn('Could not check which assets left the view', error);
    }
  }
  if (leaving.length === 0) {
    return;
  }

  for (const id of leaving) {
    assetMultiSelectManager.removeAssetFromMultiselectGroup(id);
  }
  privateModeManager.invalidate();
};

/**
 * Adds the tags [addIds] to every asset of [assetIds] and takes the tags [removeIds] off every one of them: the save of
 * the tag dialog and of the pinned tags in the selection bar. [tags] are the tags of the user, to tell whether the
 * change takes assets out of the view the session sees. Resolves to whether the tags were saved.
 */
export const handleTagAssetsChanges = async ({
  assetIds,
  addIds,
  removeIds,
  tags,
}: {
  assetIds: string[];
  addIds: string[];
  removeIds: string[];
  tags: TagResponseDto[];
}) => {
  try {
    if (addIds.length > 0) {
      await tagAssets({ tagIds: addIds, assetIds });
      rememberRecentTags(addIds);
    }
    if (removeIds.length > 0) {
      await removeTag({ tagIds: removeIds, assetIds });
    }
  } catch (error) {
    const $t = await getFormatter();
    handleError(error, $t('errors.failed_to_tag_assets'));
    return false;
  }

  // before the event, so whatever refreshes on it only asks about the assets still on screen
  await removeAssetsLeavingView(assetIds, tags, { addIds, removeIds });
  eventManager.emit('AssetsTag', assetIds);
  return true;
};

export const handleCreateTag = async (tagValue: string, { isHidden = false }: { isHidden?: boolean } = {}) => {
  const $t = await getFormatter();

  try {
    let [tag] = await upsertTags({ tagUpsertDto: { tags: [tagValue] } });
    if (!tag) {
      return;
    }

    if (isHidden && !tag.isHidden) {
      tag = await updateTag({ id: tag.id, tagUpdateDto: { isHidden } });
    }

    toastManager.primary($t('tag_created', { values: { tag: tag.value } }));
    eventManager.emit('TagCreate', tag);

    return true;
  } catch (error) {
    handleError(error, $t('errors.something_went_wrong'));
  }
};

export const handleUpdateTag = async (tag: TreeNode, dto: TagUpdateDto) => {
  const $t = await getFormatter();

  if (!tag.id) {
    return;
  }

  try {
    const response = await updateTag({ id: tag.id, tagUpdateDto: dto });

    toastManager.primary($t('tag_updated', { values: { tag: response?.value || tag.value } }));
    eventManager.emit('TagUpdate', response);

    return true;
  } catch (error) {
    handleError(error, $t('errors.something_went_wrong'));
  }
};

/** The parts of a tag path the user typed, without stray slashes or spaces around them */
export const parseTagPath = (path: string) =>
  path
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const isInSubtree = (tag: TreeNode, path: string) => path === tag.path || path.startsWith(`${tag.path}/`);

/**
 * Saves the edit dialog, where the name field takes a full path: a different parent path moves the tag (and its
 * children) under that parent, creating the parent tags that do not exist yet, and a plain name keeps it where it is.
 */
export const handleUpdateTagPath = async (
  tag: TreeNode,
  path: string,
  dto: Omit<TagUpdateDto, 'name' | 'parentId'> = {},
) => {
  const $t = await getFormatter();

  const parts = parseTagPath(path);
  const name = parts.at(-1);
  if (!name) {
    toastManager.danger($t('errors.tag_name_required'));
    return;
  }

  const parentPath = parts.slice(0, -1).join('/');
  if (parentPath === (tag.parent?.path ?? '')) {
    return handleUpdateTag(tag, { ...dto, name });
  }

  if (isInSubtree(tag, parentPath)) {
    toastManager.danger($t('errors.tag_move_into_itself'));
    return;
  }

  let parentId: string | null = null;
  if (parentPath) {
    try {
      const [parent] = await upsertTags({ tagUpsertDto: { tags: [parentPath] } });
      parentId = parent.id;
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
      return;
    }
  }

  return handleUpdateTag(tag, { ...dto, name, parentId });
};

/** Moves a tag dragged in the tag tree under [target], or to the top level for the tree root, after a confirmation */
export const handleMoveTag = async (tag: TreeNode, target: TreeNode) => {
  const $t = await getFormatter();

  if (target.path === (tag.parent?.path ?? '') || isInSubtree(tag, target.path)) {
    return;
  }

  const confirmed = await modalManager.showDialog({
    title: target.path
      ? $t('tag_move_confirm', { values: { tag: tag.value, parent: target.path } })
      : $t('tag_move_to_top_level_confirm', { values: { tag: tag.value } }),
    prompt: $t('tag_move_confirm_description'),
    confirmText: $t('move_to'),
    confirmColor: 'primary',
  });
  if (!confirmed) {
    return;
  }

  return handleUpdateTagPath(tag, target.path ? `${target.path}/${tag.value}` : tag.value);
};

const handleDeleteTag = async (tag: TreeNode) => {
  const $t = await getFormatter();

  const tagId = tag.id;
  if (!tagId) {
    return;
  }

  // a view rule on this tag (or a child, which is deleted with it) would silently disappear, so name those views
  let views: string[] = [];
  if (featureFlagsManager.value.customViews) {
    try {
      const response = await getCustomViews({ tagId });
      views = response.map(({ name }) => name);
    } catch {
      // the list is only a warning
    }
  }

  const prompt = $t('delete_tag_confirmation_prompt', { values: { tagName: tag.value } });
  const confirmed = await modalManager.showDialog({
    title: $t('delete_tag'),
    prompt:
      views.length > 0
        ? `${prompt} ${$t('delete_tag_used_by_views', { values: { count: views.length, views: views.join(', ') } })}`
        : prompt,
    confirmText: $t('delete'),
  });

  if (!confirmed) {
    return;
  }

  try {
    await deleteTag({ id: tagId });
    eventManager.emit('TagDelete', tag);
    toastManager.primary();
  } catch (error) {
    handleError(error, $t('errors.something_went_wrong'));
  }
};
