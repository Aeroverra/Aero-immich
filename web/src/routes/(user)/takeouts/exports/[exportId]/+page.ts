import { getTakeoutExport } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url, params }) => {
  await authenticate(url);
  const takeoutExport = await getTakeoutExport({ id: params.exportId });
  const $t = await getFormatter();

  return {
    takeoutExport,
    meta: {
      title: $t('takeout_export'),
    },
  };
}) satisfies PageLoad;
