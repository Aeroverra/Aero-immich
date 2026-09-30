import { getTakeoutRun } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url, params }) => {
  await authenticate(url);
  const run = await getTakeoutRun({ id: params.runId });
  const $t = await getFormatter();

  return {
    run,
    meta: {
      title: $t('takeout_run_import'),
    },
  };
}) satisfies PageLoad;
