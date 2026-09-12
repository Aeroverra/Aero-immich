<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { updateAsset, type AssetResponseDto } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { mdiLockOpenVariantOutline, mdiLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
  }

  let { asset }: Props = $props();

  const onSetPrivate = async () => {
    const isPrivate = !asset.isPrivate;

    try {
      const response = await updateAsset({ id: asset.id, updateAssetDto: { isPrivate } });
      asset.isPrivate = response.isPrivate;
      toastManager.primary(
        isPrivate ? $t('marked_private', { values: { count: 1 } }) : $t('unmarked_private', { values: { count: 1 } }),
      );
      eventManager.emit('AssetUpdate', response);
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
