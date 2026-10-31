import { getPerson, getPersonSuggestionAnswers, getPersonSuggestions } from '@immich/sdk';
import { QueryParameter } from '$lib/constants';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);

  // only the questions about one person, when coming from that person's page
  const personId = url.searchParams.get(QueryParameter.PERSON_ID) ?? undefined;
  const [suggestions, answers, person] = await Promise.all([
    getPersonSuggestions({ size: 10, personId }),
    getPersonSuggestionAnswers({ size: 10 }),
    personId ? getPerson({ id: personId }).catch(() => undefined) : undefined,
  ]);
  const $t = await getFormatter();

  return {
    suggestions,
    answers,
    person,
    meta: {
      title: $t('same_person'),
    },
  };
}) satisfies PageLoad;
