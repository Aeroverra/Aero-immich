import { getAlbumInfo, isHttpError } from '@immich/sdk';
import { redirect } from '@sveltejs/kit';
import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

export const load = (async ({ params, url, depends }) => {
  await authenticate(url);

  depends('album:data');

  let album;
  try {
    album = await getAlbumInfo({ id: params.albumId });
  } catch (error) {
    // a private album is hidden as a whole while the mode is off: the server answers 400 and the list is the way out
    if (isHttpError(error) && error.status === 400 && !privateModeManager.enabled) {
      redirect(307, Route.albums());
    }
    throw error;
  }

  return {
    album,
    meta: {
      title: album.albumName,
    },
  };
}) satisfies PageLoad;
