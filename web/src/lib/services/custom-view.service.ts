import { ViewAccess, type CustomViewResponseDto } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import { viewManager } from '$lib/managers/view-manager.svelte';
import PrivateModePinModal from '$lib/modals/PrivateModePinModal.svelte';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

/**
 * Switches the session to a view; null or the default view switches back to the default, which never needs anything.
 * A locked view asks for the PIN on every switch. Resolves to true once the session is on the view.
 */
export const switchCustomView = async (view: CustomViewResponseDto | null) => {
  const $t = await getFormatter();
  const viewId = view && !view.isDefault ? view.id : null;

  if (view && viewId && view.access === ViewAccess.Locked) {
    const switched = await modalManager.show(PrivateModePinModal, {
      title: $t('custom_view_switch_locked_title', { values: { name: view.name } }),
      description: $t('custom_view_switch_locked_description'),
      onPinCode: (pinCode: string) => viewManager.switch(viewId, pinCode),
    });
    return !!switched;
  }

  try {
    await viewManager.switch(viewId);
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_switch_custom_view'));
    return false;
  }
};
