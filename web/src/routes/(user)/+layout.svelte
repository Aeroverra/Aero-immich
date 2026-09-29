<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import UploadCover from './DragAndDropUploadOverlay.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { handleHiddenAsset, type HiddenAsset } from '$lib/services/hidden-asset.service';
  import { navigate } from '$lib/utils/navigation';
  import { toastManager } from '@immich/ui';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  interface Props {
    children?: Snippet;
  }

  let { children }: Props = $props();

  // not state: the reloads while the dialogs are open must not start the flow again
  let resolvingAssetId: string | undefined;

  const resolveHiddenAsset = async (hidden: HiddenAsset) => {
    resolvingAssetId = hidden.assetId;
    try {
      if (await handleHiddenAsset(hidden)) {
        await invalidateAll();
        if (page.data.hiddenAsset?.assetId !== hidden.assetId) {
          return;
        }
        toastManager.warning($t('hidden_asset_not_found'));
      }
      await navigate({ targetRoute: 'current', assetId: null }, { replaceState: true });
    } finally {
      resolvingAssetId = undefined;
    }
  };

  // an asset opened by link that private mode or the active view hides: ask for the PIN or a view that shows it
  $effect(() => {
    const hidden = page.data.hiddenAsset;
    if (hidden && hidden.assetId !== resolvingAssetId) {
      void resolveHiddenAsset(hidden);
    }
  });

  // $page.data.asset is loaded by route specific +page.ts loaders if that
  // route contains the assetId path.
  $effect.pre(() => {
    if (page.data.asset) {
      assetViewerManager.setAsset(page.data.asset);
    } else {
      assetViewerManager.showAssetViewer(false);
    }
    const asset = page.url.searchParams.get('at');
    assetViewerManager.gridScrollTarget = { at: asset };
  });
</script>

<div class:display-none={assetViewerManager.isViewing}>
  {@render children?.()}
</div>
<UploadCover />

<style>
  :root {
    overscroll-behavior: none;
  }
  .display-none {
    display: none;
  }
</style>
