import { getPerson, getPersonStatistics, getPersonSuggestionStatistics } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ params, url }) => {
  await authenticate(url);

  const [person, statistics, suggestions] = await Promise.all([
    getPerson({ id: params.personId }),
    getPersonStatistics({ id: params.personId }),
    // the questions are a nice to have: the page works without their count
    getPersonSuggestionStatistics({ personId: params.personId }).catch(() => ({ pending: 0 })),
  ]);
  const $t = await getFormatter();

  return {
    person,
    statistics,
    suggestions,
    meta: {
      title: person.name || $t('person'),
    },
  };
}) satisfies PageLoad;
