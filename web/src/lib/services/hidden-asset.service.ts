import {
  getActiveCustomView,
  getAssetInfo,
  getAuthStatus,
  getCustomViews,
  isHttpError,
  type CustomViewResponseDto,
} from '@immich/sdk';
import { modalManager, toastManager } from '@immich/ui';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import HiddenAssetViewModal from '$lib/modals/HiddenAssetViewModal.svelte';
import PrivateModePinModal from '$lib/modals/PrivateModePinModal.svelte';
import { switchCustomView } from '$lib/services/custom-view.service';
import { getFormatter } from '$lib/utils/i18n';

export type HiddenAssetViews = {
  /** the views the session can switch to that show the asset */
  views: CustomViewResponseDto[];
  /** the user has no default view, so switching back to the default (all photos) shows the asset too */
  allPhotos: boolean;
  /** the name of the active view, when it is a view at all */
  currentViewName?: string;
};

export type HiddenAsset = HiddenAssetViews & {
  assetId: string;
  /** private mode is off and the user has a PIN, so turning it on may show the asset */
  canUnlock: boolean;
};

/**
 * The server answers an asset that does not exist, one that is private while private mode is off and one the active
 * view hides with the same 400, so the three cannot (and must not) be told apart from the error alone.
 */
export const isHiddenAssetError = (error: unknown) => isHttpError(error) && error.status === 400;

const hasCustomViews = () => {
  try {
    return !!featureFlagsManager.value.customViews;
  } catch {
    return false;
  }
};

const getHiddenAssetViews = async (assetId: string): Promise<HiddenAssetViews> => {
  if (!hasCustomViews()) {
    return { views: [], allPhotos: false };
  }

  try {
    const [views, active] = await Promise.all([getCustomViews({ assetId }), getActiveCustomView()]);
    // the server only lists views for an asset that is readable apart from the active view, so the default
    // (everything) shows it whenever there is no default view to narrow it
    const allViews = active.viewId ? await getCustomViews({}) : [];
    const allPhotos = !!active.viewId && allViews.every((view) => !view.isDefault);
    return {
      views: views.filter((view) => view.id !== active.viewId),
      allPhotos,
      currentViewName: active.view?.name,
    };
  } catch {
    // not readable in any view: missing, private while private mode is off, or someone else's
    return { views: [], allPhotos: false };
  }
};

const isReadable = async (id: string) => {
  try {
    await getAssetInfo({ id });
    return true;
  } catch {
    return false;
  }
};

/**
 * What could show an asset the session cannot read: turning on private mode and the views that show it. Undefined
 * when nothing could, so the caller shows the usual error. Nothing here tells a private asset from a missing one
 * while private mode is off: both offer the PIN.
 */
export const getHiddenAsset = async (assetId: string): Promise<HiddenAsset | undefined> => {
  try {
    const [{ pinCode, privateMode }, views] = await Promise.all([getAuthStatus(), getHiddenAssetViews(assetId)]);
    const canUnlock = pinCode && !privateMode;
    if (!canUnlock && views.views.length === 0 && !views.allPhotos) {
      return;
    }
    return { assetId, canUnlock, ...views };
  } catch {
    return;
  }
};

/**
 * Walks the user to an asset they opened by link while it is hidden: the PIN first when private mode may be what
 * hides it, then a choice of the views that show it (the app switches to the chosen one). Resolves to true once the
 * asset should be readable.
 */
export const handleHiddenAsset = async (hidden: HiddenAsset) => {
  const $t = await getFormatter();
  let views: HiddenAssetViews = hidden;

  if (views.views.length === 0 && !views.allPhotos && hidden.canUnlock) {
    const enabled = await modalManager.show(PrivateModePinModal, {
      description: $t('hidden_asset_unlock_description'),
    });
    if (!enabled) {
      return false;
    }

    if (await isReadable(hidden.assetId)) {
      return true;
    }

    // private mode is on now, but the active view can still hide the asset
    views = await getHiddenAssetViews(hidden.assetId);
  }

  if (views.views.length === 0 && !views.allPhotos) {
    toastManager.warning($t('hidden_asset_not_found'));
    return false;
  }

  const choice = (await modalManager.show(HiddenAssetViewModal, {
    views: views.views,
    allPhotos: views.allPhotos,
    currentViewName: views.currentViewName ?? $t('custom_view_all_photos'),
  })) as { view: CustomViewResponseDto | null } | undefined;
  if (!choice) {
    return false;
  }

  return switchCustomView(choice.view);
};
