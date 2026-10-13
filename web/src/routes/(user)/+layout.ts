import { getHiddenAsset, isHiddenAssetError } from '$lib/services/hidden-asset.service';
import { authenticate } from '$lib/utils/auth';
import { getAssetInfoFromParam, isSharedLinkRoute } from '$lib/utils/navigation';
import type { LayoutLoad } from './$types';

export const load = (async ({ url, params, route }) => {
  const isSharedLink = isSharedLinkRoute(route.id);
  await authenticate(url, { public: isSharedLink });

  try {
    const asset = await getAssetInfoFromParam(params);

    return {
      asset,
    };
  } catch (error) {
    // a private asset or one the active view hides answers like a missing one: offer what could show it instead
    const hiddenAsset =
      params.assetId && !isSharedLink && isHiddenAssetError(error) ? await getHiddenAsset(params.assetId) : undefined;
    if (!hiddenAsset) {
      throw error;
    }

    return {
      asset: undefined,
      hiddenAsset,
    };
  }
}) satisfies LayoutLoad;
