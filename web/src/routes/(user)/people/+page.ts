import { getAllPeople, getPersonSuggestionStatistics } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);

  const [people, suggestions] = await Promise.all([
    getAllPeople({ withHidden: true }),
    // the questions are a nice to have: the page works without their count
    getPersonSuggestionStatistics().catch(() => ({ pending: 0 })),
  ]);
  const $t = await getFormatter();

  return {
    people,
    suggestions,
    meta: {
      title: $t('people'),
    },
  };
}) satisfies PageLoad;
