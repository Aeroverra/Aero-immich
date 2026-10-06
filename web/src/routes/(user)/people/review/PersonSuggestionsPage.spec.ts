import {
  answerPersonSuggestion,
  getPersonSuggestions,
  getPersonSuggestionStatistics,
  mergePeople,
  PersonSuggestionAnswer,
  PersonSuggestionKind,
  PersonSuggestionSource,
  PersonSuggestionStatus,
  refreshPersonSuggestions,
  searchPerson,
  undoPersonSuggestionAnswer,
  type PersonResponseDto,
  type PersonSuggestionResponseDto,
} from '@immich/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'svelte';
import { personFactory } from '@test-data/factories/person-factory';
import PersonSuggestionsPage from './+page.svelte';
import PersonSuggestionsPageTestWrapper from './PersonSuggestionsPage.test-wrapper.svelte';

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return {
    ...sdk,
    answerPersonSuggestion: vi.fn(),
    getPersonSuggestions: vi.fn(),
    getPersonSuggestionStatistics: vi.fn(),
    mergePeople: vi.fn(),
    refreshPersonSuggestions: vi.fn(),
    searchPerson: vi.fn(),
    undoPersonSuggestionAnswer: vi.fn(),
  };
});

vi.mock('$lib/components/layouts/UserPageLayout.svelte', async () => {
  return await import('@test-data/mocks/UserPageLayout.mock.svelte');
});

const face = (id: string) => ({
  id,
  assetId: `asset-${id}`,
  takenAt: '2024-05-01T10:00:00.000Z',
  updatedAt: '2024-05-02T10:00:00.000Z',
});

const newSuggestion = (id: string, target: PersonResponseDto, status = PersonSuggestionStatus.Pending) =>
  ({
    id,
    kind: target.name ? PersonSuggestionKind.Named : PersonSuggestionKind.Unnamed,
    source: PersonSuggestionSource.Automatic,
    status,
    score: 0.42,
    answeredAt: status === PersonSuggestionStatus.Pending ? null : '2026-10-06T10:00:00.000Z',
    candidate: { person: personFactory.build({ name: '' }), assetCount: 2, faces: [face(`${id}-c`)] },
    target: { person: target, assetCount: 50, faces: [face(`${id}-t`)] },
  }) satisfies PersonSuggestionResponseDto;

const getData = (
  suggestions: PersonSuggestionResponseDto[],
  answers: PersonSuggestionResponseDto[] = [],
): ComponentProps<typeof PersonSuggestionsPage>['data'] => ({
  error: undefined,
  meta: { title: 'Same person?' },
  asset: undefined,
  suggestions: { suggestions, total: suggestions.length, hasNextPage: false },
  answers,
});

describe('Same person? page', () => {
  const anna = personFactory.build({ name: 'Anna' });
  const ben = personFactory.build({ name: 'Ben' });

  beforeEach(() => {
    vi.mocked(searchPerson).mockResolvedValue([]);
  });

  it('asks the next question after an answer and takes the answer back', async () => {
    const first = newSuggestion('first', anna);
    const second = newSuggestion('second', ben);
    vi.mocked(answerPersonSuggestion).mockResolvedValue({
      ...first,
      status: PersonSuggestionStatus.Different,
    });
    vi.mocked(getPersonSuggestions).mockResolvedValue({ suggestions: [second], total: 1, hasNextPage: false });
    vi.mocked(undoPersonSuggestionAnswer).mockResolvedValue(first);
    const user = userEvent.setup();

    render(PersonSuggestionsPageTestWrapper, { data: getData([first, second]) });
    expect(screen.getAllByTestId('suggestion-side-title')[1]).toHaveTextContent('Anna');

    await user.click(screen.getByTestId('suggestion-different'));

    expect(answerPersonSuggestion).toHaveBeenCalledWith({
      id: 'first',
      personSuggestionAnswerDto: { answer: PersonSuggestionAnswer.Different, name: undefined },
    });
    await waitFor(() => expect(screen.getAllByTestId('suggestion-side-title')[1]).toHaveTextContent('Ben'));
    expect(screen.getAllByTestId('suggestion-answer')).toHaveLength(1);

    await user.keyboard('z');

    expect(undoPersonSuggestionAnswer).toHaveBeenCalledWith({ id: 'first' });
    await waitFor(() => expect(screen.getAllByTestId('suggestion-side-title')[1]).toHaveTextContent('Anna'));
    expect(screen.queryAllByTestId('suggestion-answer')).toHaveLength(0);
  });

  it('takes back an earlier answer from the list', async () => {
    const answered = newSuggestion('answered', ben, PersonSuggestionStatus.Same);
    vi.mocked(undoPersonSuggestionAnswer).mockResolvedValue({ ...answered, status: PersonSuggestionStatus.Pending });
    const user = userEvent.setup();

    render(PersonSuggestionsPageTestWrapper, { data: getData([], [answered]) });
    expect(screen.getByTestId('suggestion-empty')).toBeInTheDocument();

    await user.click(screen.getAllByText('same_person_undo').at(-1)!);

    await waitFor(() => expect(screen.getByTestId('suggestion-question')).toBeInTheDocument());
    expect(screen.getAllByTestId('suggestion-side-title')[1]).toHaveTextContent('Ben');
  });

  it('merges into a person who already has the given name', async () => {
    const unnamed = personFactory.build({ name: '' });
    const katie = personFactory.build({ name: 'Katie' });
    const question = newSuggestion('pair', unnamed);
    vi.mocked(searchPerson).mockResolvedValue([katie]);
    vi.mocked(answerPersonSuggestion).mockResolvedValue({ ...question, status: PersonSuggestionStatus.Same });
    vi.mocked(getPersonSuggestions).mockResolvedValue({ suggestions: [], total: 0, hasNextPage: false });
    vi.mocked(mergePeople).mockResolvedValue([]);
    const user = userEvent.setup();

    render(PersonSuggestionsPageTestWrapper, { data: getData([question]) });
    await user.click(screen.getByTestId('suggestion-same'));
    await user.keyboard('Katie');
    await waitFor(() => expect(screen.getByTestId('suggestion-name-existing')).toBeInTheDocument());
    await user.keyboard('{Enter}');

    await waitFor(() => expect(mergePeople).toHaveBeenCalledWith({ mergePersonDto: { ids: [katie.id, unnamed.id] } }));
    expect(answerPersonSuggestion).toHaveBeenCalledWith({
      id: 'pair',
      personSuggestionAnswerDto: { answer: PersonSuggestionAnswer.Same, name: undefined },
    });
  });

  it('looks for more questions when there are none', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(refreshPersonSuggestions).mockResolvedValue(undefined as never);
    vi.mocked(getPersonSuggestionStatistics).mockResolvedValue({ pending: 1 });
    vi.mocked(getPersonSuggestions).mockResolvedValue({
      suggestions: [newSuggestion('new', anna)],
      total: 1,
      hasNextPage: false,
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(PersonSuggestionsPageTestWrapper, { data: getData([]) });
    await user.click(screen.getByTestId('suggestion-look'));

    expect(refreshPersonSuggestions).toHaveBeenCalled();
    expect(screen.getByTestId('suggestion-looking')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(3500);

    await waitFor(() => expect(screen.getByTestId('suggestion-question')).toBeInTheDocument());
    vi.useRealTimers();
  });
});
