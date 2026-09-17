import { deleteTag, getCustomViews, updateTag, upsertTags, type TagUpdateDto } from '@immich/sdk';
import { modalManager, toastManager, type ActionItem } from '@immich/ui';
import { mdiPencil, mdiPlus, mdiTrashCanOutline } from '@mdi/js';
import { type MessageFormatter } from 'svelte-i18n';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import TagCreateModal from '$lib/modals/TagCreateModal.svelte';
import TagEditModal from '$lib/modals/TagEditModal.svelte';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';
import type { TreeNode } from '$lib/utils/tree-utils';

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

const handleDeleteTag = async (tag: TreeNode) => {
  const $t = await getFormatter();

  const tagId = tag.id;
  if (!tagId) {
    return;
  }

  // a view rule on this tag (or a child, which is deleted with it) would silently disappear, so name those views
  let views: string[] = [];
  if (featureFlagsManager.value.views) {
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
