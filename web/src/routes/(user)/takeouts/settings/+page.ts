import { getTakeoutSettings } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const settings = await getTakeoutSettings();
  const $t = await getFormatter();

  return {
    settings,
    meta: {
      title: $t('takeout_settings'),
    },
  };
}) satisfies PageLoad;
