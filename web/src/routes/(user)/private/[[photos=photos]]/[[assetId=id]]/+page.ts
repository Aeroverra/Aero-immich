import { getAuthStatus } from '@immich/sdk';
import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);

  const { privateMode } = await getAuthStatus();
  if (!privateMode) {
    // private mode is turned on from the navigation bar toggle
    redirect(307, Route.photos());
  }

  const $t = await getFormatter();

  return {
    meta: {
      title: $t('private_photos'),
    },
  };
}) satisfies PageLoad;
