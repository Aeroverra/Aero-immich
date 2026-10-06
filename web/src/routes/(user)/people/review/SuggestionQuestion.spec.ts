import {
  PersonSuggestionAnswer,
  PersonSuggestionKind,
  PersonSuggestionSource,
  PersonSuggestionStatus,
  searchPerson,
  type PersonResponseDto,
  type PersonSuggestionResponseDto,
} from '@immich/sdk';
import { screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { renderWithTooltips } from '$tests/helpers';
import { personFactory } from '@test-data/factories/person-factory';
import SuggestionQuestion from './SuggestionQuestion.svelte';

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return { ...sdk, searchPerson: vi.fn() };
});

const face = (id: string) => ({
  id,
  assetId: `asset-${id}`,
  takenAt: '2024-05-01T10:00:00.000Z',
  updatedAt: '2024-05-02T10:00:00.000Z',
});

const newSuggestion = (target: PersonResponseDto | null, candidate: PersonResponseDto | null = null) =>
  ({
    id: 'suggestion-1',
    kind: target?.name ? PersonSuggestionKind.Named : PersonSuggestionKind.Unnamed,
    source: PersonSuggestionSource.Automatic,
    status: PersonSuggestionStatus.Pending,
    score: 0.42,
    answeredAt: null,
    candidate: { person: candidate, assetCount: 3, faces: [face('c1'), face('c2'), face('c3')] },
    target: { person: target, assetCount: 120, faces: [face('t1'), face('t2'), face('t3'), face('t4')] },
  }) satisfies PersonSuggestionResponseDto;

const renderQuestion = (suggestion: PersonSuggestionResponseDto, busy = false) => {
  const onAnswer = vi.fn();
  renderWithTooltips(SuggestionQuestion, { suggestion, busy, onAnswer });
  return { onAnswer };
};

describe('SuggestionQuestion', () => {
  beforeEach(() => {
    vi.mocked(searchPerson).mockResolvedValue([]);
  });

  it('asks whether the candidate is the named person and shows both sides', () => {
    const anna = personFactory.build({ name: 'Anna' });
    renderQuestion(newSuggestion(anna, personFactory.build({ name: '' })));

    expect(screen.getByTestId('suggestion-title')).toHaveTextContent('same_person_question_named');
    const faces = screen.getAllByTestId('suggestion-face');
    expect(faces).toHaveLength(7);
    expect(faces[0].getAttribute('src')).toContain('/faces/c1/thumbnail');
    expect(faces[3].getAttribute('src')).toContain('/faces/t1/thumbnail');
    // a face opens its photo with the face pointed out
    expect(faces[0].closest('a')?.getAttribute('href')).toBe('/photos/asset-c1?face=c1');
    const titles = screen.getAllByTestId('suggestion-side-title');
    expect(titles[0]).toHaveTextContent('same_person_this_person');
    expect(titles[1]).toHaveTextContent('Anna');
  });

  it('calls a face without a person a face', () => {
    renderQuestion(newSuggestion(personFactory.build({ name: 'Anna' })));

    expect(screen.getAllByTestId('suggestion-side-title')[0]).toHaveTextContent('same_person_this_face');
    // only the named person can be opened, a face has no person yet
    expect(screen.getAllByTestId('suggestion-side-person')).toHaveLength(1);
  });

  it('opens either person in a new tab to check everyone in it', () => {
    const anna = personFactory.build({ name: 'Anna' });
    const cluster = personFactory.build({ name: '' });
    renderQuestion(newSuggestion(anna, cluster));

    const links = screen.getAllByTestId('suggestion-side-person');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([`/people/${cluster.id}`, `/people/${anna.id}`]);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
    }
  });

  it('answers with the buttons', async () => {
    const user = userEvent.setup();
    const { onAnswer } = renderQuestion(newSuggestion(personFactory.build({ name: 'Anna' })));

    await user.click(screen.getByTestId('suggestion-same'));
    await user.click(screen.getByTestId('suggestion-different'));
    await user.click(screen.getByTestId('suggestion-skip'));

    expect(onAnswer.mock.calls).toEqual([
      [PersonSuggestionAnswer.Same],
      [PersonSuggestionAnswer.Different],
      [PersonSuggestionAnswer.Skipped],
    ]);
  });

  it('answers with the keyboard', async () => {
    const user = userEvent.setup();
    const { onAnswer } = renderQuestion(newSuggestion(personFactory.build({ name: 'Anna' })));

    await user.keyboard('s');
    await user.keyboard('d');
    await user.keyboard('n');

    expect(onAnswer.mock.calls).toEqual([
      [PersonSuggestionAnswer.Same],
      [PersonSuggestionAnswer.Different],
      [PersonSuggestionAnswer.Skipped],
    ]);
  });

  it('does not answer while an answer is saved', async () => {
    const user = userEvent.setup();
    const { onAnswer } = renderQuestion(newSuggestion(personFactory.build({ name: 'Anna' })), true);

    await user.keyboard('s');

    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getByTestId('suggestion-same')).toBeDisabled();
  });

  it('asks for a name when two unnamed people are the same', async () => {
    const user = userEvent.setup();
    const { onAnswer } = renderQuestion(
      newSuggestion(personFactory.build({ name: '' }), personFactory.build({ name: '' })),
    );
    expect(screen.getByTestId('suggestion-title')).toHaveTextContent('same_person_question_unnamed');

    await user.click(screen.getByTestId('suggestion-same'));
    expect(onAnswer).not.toHaveBeenCalled();
    const form = screen.getByTestId('suggestion-name-form');
    expect(form).toBeInTheDocument();

    // the shortcuts are off while typing
    await user.keyboard('Dana');
    expect(screen.getByTestId('suggestion-merge')).toHaveTextContent('same_person_merge_and_name');
    await user.keyboard('{Enter}');

    expect(onAnswer).toHaveBeenCalledWith(PersonSuggestionAnswer.Same, 'Dana', undefined);
  });

  it('merges without a name when the name is left empty', async () => {
    const user = userEvent.setup();
    const { onAnswer } = renderQuestion(
      newSuggestion(personFactory.build({ name: '' }), personFactory.build({ name: '' })),
    );

    await user.click(screen.getByTestId('suggestion-same'));
    expect(screen.getByTestId('suggestion-merge')).toHaveTextContent('same_person_merge_without_name');
    await user.click(screen.getByTestId('suggestion-merge'));

    expect(onAnswer).toHaveBeenCalledWith(PersonSuggestionAnswer.Same, undefined, undefined);
  });

  it('merges without a name with S and Enter', async () => {
    const user = userEvent.setup();
    const { onAnswer } = renderQuestion(
      newSuggestion(personFactory.build({ name: '' }), personFactory.build({ name: '' })),
    );

    await user.keyboard('s');
    await user.keyboard('{Enter}');

    expect(onAnswer).toHaveBeenCalledWith(PersonSuggestionAnswer.Same, undefined, undefined);
  });

  it('goes back to the question on escape', async () => {
    const user = userEvent.setup();
    const { onAnswer } = renderQuestion(
      newSuggestion(personFactory.build({ name: '' }), personFactory.build({ name: '' })),
    );

    await user.click(screen.getByTestId('suggestion-same'));
    await user.keyboard('{Escape}');

    expect(screen.queryByTestId('suggestion-name-form')).not.toBeInTheDocument();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('offers to merge into a person who already has the name', async () => {
    const katie = personFactory.build({ name: 'Katie Scannell' });
    vi.mocked(searchPerson).mockResolvedValue([katie]);
    const user = userEvent.setup();
    const { onAnswer } = renderQuestion(
      newSuggestion(personFactory.build({ name: '' }), personFactory.build({ name: '' })),
    );

    await user.click(screen.getByTestId('suggestion-same'));
    await user.keyboard('katie scannell');
    await waitFor(() => expect(screen.getByTestId('suggestion-name-existing')).toBeInTheDocument());
    await user.keyboard('{Enter}');

    expect(onAnswer).toHaveBeenCalledWith(PersonSuggestionAnswer.Same, 'katie scannell', katie);
  });
});
