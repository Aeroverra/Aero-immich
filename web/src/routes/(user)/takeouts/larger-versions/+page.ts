import { getTakeoutLargerVersions, TakeoutLargerVersionFilter } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const largerVersions = await getTakeoutLargerVersions({ status: TakeoutLargerVersionFilter.Pending });
  const $t = await getFormatter();

  return {
    largerVersions,
    meta: {
      title: $t('takeout_larger_versions'),
    },
  };
}) satisfies PageLoad;
