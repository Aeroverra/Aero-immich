<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { AssetAction } from '$lib/constants';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
  import { handleMarkPrivateAlbums } from '$lib/services/private-mode.service';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { updateAsset, type AssetResponseDto } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { mdiLockOpenVariantOutline, mdiLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { OnAction, PreAction } from './action';

  interface Props {
    asset: AssetResponseDto;
    onAction: OnAction;
    preAction: PreAction;
  }

  let { asset, onAction, preAction }: Props = $props();

  const onSetPrivate = async () => {
    const isPrivate = !asset.isPrivate;
    const type = isPrivate ? AssetAction.SET_PRIVATE : AssetAction.UNSET_PRIVATE;

    // the albums holding this asset turn private with it, the user decides what happens to them first
    if (isPrivate && !(await handleMarkPrivateAlbums([asset.id]))) {
      return;
    }

    try {
      // while the mode is off the asset disappears from the view, so move on to the next one first
      // (same flow as moving an asset to the locked folder)
      if (isPrivate && !privateModeManager.enabled) {
        preAction({ type, asset: toTimelineAsset(asset) });
      }

      const response = await updateAsset({ id: asset.id, updateAssetDto: { isPrivate } });
      asset.isPrivate = response.isPrivate;
      toastManager.primary(
        isPrivate ? $t('marked_private', { values: { count: 1 } }) : $t('unmarked_private', { values: { count: 1 } }),
      );
      eventManager.emit('AssetUpdate', response);
      onAction({ type, asset: toTimelineAsset(response) });
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_private', { values: { private: isPrivate } }));
    }
  };
</script>

<MenuOption
  icon={asset.isPrivate ? mdiLockOpenVariantOutline : mdiLockOutline}
  text={asset.isPrivate ? $t('unmark_private') : $t('mark_private')}
  onClick={onSetPrivate}
/>
