import { BulkIdErrorReason, type PersonResponseDto } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import AssetPeopleModal from '$lib/modals/AssetPeopleModal.svelte';
import { renderWithTooltips } from '$tests/helpers';

const newPerson = (id: string, name: string): PersonResponseDto => ({
  id,
  name,
  birthDate: null,
  thumbnailPath: '',
  isHidden: false,
  isFavorite: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('AssetPeopleModal', () => {
  const assetIds = ['photo-1', 'photo-2', 'video-1'];
  const onClose = vi.fn();

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(toastManager, 'primary').mockImplementation(() => {});
    vi.spyOn(toastManager, 'info').mockImplementation(() => {});
    vi.spyOn(toastManager, 'warning').mockImplementation(() => {});
    sdkMock.getAllPeople.mockResolvedValue({
      people: [newPerson('unnamed', ''), newPerson('dana', 'Dana'), newPerson('ann', 'Ann'), newPerson('bob', 'Bob')],
      hasNextPage: false,
      total: 4,
      hidden: 0,
    });
    // Ann is on every item (on one through a detected face), Bob on one of them, Dana on none
    sdkMock.getPersonAssetCounts.mockResolvedValue([
      { personId: 'ann', count: 3, removableCount: 2 },
      { personId: 'bob', count: 1, removableCount: 1 },
    ]);
    sdkMock.addPersonToAssets.mockResolvedValue([
      { id: 'photo-1', success: true },
      { id: 'photo-2', success: true },
      { id: 'video-1', success: true },
    ]);
    sdkMock.removePersonFromAssets.mockResolvedValue([
      { id: 'photo-1', success: true },
      { id: 'photo-2', success: false, error: BulkIdErrorReason.Validation },
      { id: 'video-1', success: true },
    ]);
  });

  const person = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

  it('shows who is on all, some or none of the items, people on the selection first', async () => {
    renderWithTooltips(AssetPeopleModal, { assetIds, onClose });
    await waitFor(() => expect(person('Ann')).toBeInTheDocument());

    const names = screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-pressed'))
      .map((button) => button.textContent?.trim());
    expect(names).toEqual(['Ann', 'Bob', 'Dana', '']);
    expect(person('Ann')).toHaveAttribute('aria-pressed', 'true');
    expect(person('Bob')).toHaveAttribute('aria-pressed', 'mixed');
    expect(person('Bob')).toHaveAttribute('data-partial');
    expect(person('Dana')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(sdkMock.getPersonAssetCounts).toHaveBeenCalledWith({ personAssetCountsDto: { assetIds } });
  });

  it('adds checked people to every item and takes unchecked ones off', async () => {
    const emit = vi.spyOn(eventManager, 'emit');
    renderWithTooltips(AssetPeopleModal, { assetIds, onClose });
    await waitFor(() => expect(person('Ann')).toBeInTheDocument());

    await userEvent.click(person('Dana'));
    await userEvent.click(person('Ann'));
    expect(screen.getByTestId('people-changes-add')).toHaveTextContent('Dana');
    expect(screen.getByTestId('people-changes-remove')).toHaveTextContent('Ann');
    expect(screen.getByText('Ann stays on 1 item where their face was found')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(sdkMock.addPersonToAssets).toHaveBeenCalledWith({ id: 'dana', bulkIdsDto: { ids: assetIds } });
    expect(sdkMock.removePersonFromAssets).toHaveBeenCalledWith({ id: 'ann', bulkIdsDto: { ids: assetIds } });
    expect(emit).toHaveBeenCalledWith('AssetsPeopleUpdate', ['photo-1', 'photo-2', 'video-1']);
    expect(toastManager.primary).toHaveBeenCalledWith('Added Dana to 3 items');
    expect(toastManager.primary).toHaveBeenCalledWith('Removed Ann from 2 items');
    expect(toastManager.info).toHaveBeenCalledWith(
      'Kept on 1 item where the face was found in the picture. Change those in Edit faces.',
    );
  });

  it('adds a person only some items have to all of them', async () => {
    renderWithTooltips(AssetPeopleModal, { assetIds, onClose });
    await waitFor(() => expect(person('Bob')).toBeInTheDocument());

    await userEvent.click(person('Bob'));

    expect(person('Bob')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('people-changes-add')).toHaveTextContent('Bob');
  });

  it('changes nothing when a person is toggled back', async () => {
    renderWithTooltips(AssetPeopleModal, { assetIds, onClose });
    await waitFor(() => expect(person('Dana')).toBeInTheDocument());

    await userEvent.click(person('Dana'));
    await userEvent.click(person('Dana'));

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('says so when nothing changed', async () => {
    sdkMock.addPersonToAssets.mockResolvedValue([
      { id: 'photo-1', success: false, error: BulkIdErrorReason.Duplicate },
    ]);
    renderWithTooltips(AssetPeopleModal, { assetIds: ['photo-1'], onClose });
    await waitFor(() => expect(person('Dana')).toBeInTheDocument());

    await userEvent.click(person('Dana'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(false));
    expect(toastManager.warning).toHaveBeenCalledWith('The selected items already had these people');
    expect(toastManager.primary).not.toHaveBeenCalled();
  });

  it('adds the best match with Enter instead of creating a person', async () => {
    renderWithTooltips(AssetPeopleModal, { assetIds, onClose });
    await waitFor(() => expect(person('Dana')).toBeInTheDocument());

    await userEvent.type(screen.getByTestId('people-search'), 'da{Enter}');

    expect(screen.getByTestId('people-changes-add')).toHaveTextContent('Dana');
    expect(screen.getByTestId('people-search')).toHaveValue('');
    expect(sdkMock.createPerson).not.toHaveBeenCalled();
  });

  it('creates a person from the search with Enter and adds them', async () => {
    sdkMock.createPerson.mockResolvedValue(newPerson('cleo', 'Cleo'));
    renderWithTooltips(AssetPeopleModal, { assetIds, onClose });
    await waitFor(() => expect(person('Ann')).toBeInTheDocument());

    await userEvent.type(screen.getByTestId('people-search'), 'Cleo');
    expect(screen.getByTestId('people-create')).toHaveTextContent('Create person "Cleo"');
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByTestId('people-changes-add')).toHaveTextContent('Cleo'));
    expect(sdkMock.createPerson).toHaveBeenCalledWith({ personCreateDto: { name: 'Cleo' } });
    expect(onClose).not.toHaveBeenCalled();
  });
});
