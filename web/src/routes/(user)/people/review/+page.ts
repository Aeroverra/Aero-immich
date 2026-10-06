import { getPersonSuggestionAnswers, getPersonSuggestions } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);

  const [suggestions, answers] = await Promise.all([
    getPersonSuggestions({ size: 10 }),
    getPersonSuggestionAnswers({ size: 10 }),
  ]);
  const $t = await getFormatter();

  return {
    suggestions,
    answers,
    meta: {
      title: $t('same_person'),
    },
  };
}) satisfies PageLoad;
