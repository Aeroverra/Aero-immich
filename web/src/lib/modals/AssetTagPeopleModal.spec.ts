import { BulkIdErrorReason, type PersonResponseDto } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import AssetTagPeopleModal from '$lib/modals/AssetTagPeopleModal.svelte';
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

describe('AssetTagPeopleModal', () => {
  const assetIds = ['video-1', 'video-2', 'photo-1'];
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
      people: [newPerson('unnamed', ''), newPerson('ann', 'Ann'), newPerson('bob', 'Bob')],
      hasNextPage: false,
      total: 3,
      hidden: 0,
    });
    sdkMock.addPersonToAssets.mockResolvedValue([
      { id: 'video-1', success: true },
      { id: 'video-2', success: false, error: BulkIdErrorReason.Duplicate },
      { id: 'photo-1', success: false, error: BulkIdErrorReason.Validation },
    ]);
  });

  const person = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

  it('lists named people first and filters them by name', async () => {
    renderWithTooltips(AssetTagPeopleModal, { assetIds, onClose });
    await waitFor(() => expect(person('Ann')).toBeInTheDocument());

    const names = screen.getAllByRole('button', { pressed: false }).map((button) => button.textContent?.trim());
    expect(names).toEqual(['Ann', 'Bob', '']);
    expect(screen.getByRole('button', { name: 'Tag' })).toBeDisabled();

    await userEvent.type(screen.getByTestId('tag-people-search'), 'bo');
    expect(screen.queryByRole('button', { name: /^Ann/ })).not.toBeInTheDocument();
    expect(person('Bob')).toBeInTheDocument();
  });

  it('tags every picked person on the assets and reports skipped photos', async () => {
    const emit = vi.spyOn(eventManager, 'emit');
    renderWithTooltips(AssetTagPeopleModal, { assetIds, onClose });
    await waitFor(() => expect(person('Ann')).toBeInTheDocument());

    await userEvent.click(person('Ann'));
    await userEvent.click(person('Bob'));
    expect(screen.getByTestId('tag-people-selected')).toHaveTextContent('Ann');
    expect(screen.getByTestId('tag-people-selected')).toHaveTextContent('Bob');
    await userEvent.click(screen.getByRole('button', { name: 'Tag' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(sdkMock.addPersonToAssets).toHaveBeenCalledWith({ id: 'ann', bulkIdsDto: { ids: assetIds } });
    expect(sdkMock.addPersonToAssets).toHaveBeenCalledWith({ id: 'bob', bulkIdsDto: { ids: assetIds } });
    expect(emit).toHaveBeenCalledWith('PersonAssetsAdd', ['video-1']);
    expect(toastManager.primary).toHaveBeenCalledWith('Tagged Ann, Bob in 1 video');
    expect(toastManager.info).toHaveBeenCalledWith('1 photo was skipped, only videos get tagged this way');
  });

  it('says so when every video already had the people', async () => {
    sdkMock.addPersonToAssets.mockResolvedValue([
      { id: 'video-1', success: false, error: BulkIdErrorReason.Duplicate },
    ]);
    renderWithTooltips(AssetTagPeopleModal, { assetIds: ['video-1'], onClose });
    await waitFor(() => expect(person('Ann')).toBeInTheDocument());

    await userEvent.click(person('Ann'));
    await userEvent.click(screen.getByRole('button', { name: 'Tag' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(false));
    expect(toastManager.warning).toHaveBeenCalledWith('The selected videos already have these people');
    expect(toastManager.primary).not.toHaveBeenCalled();
  });

  it('creates a person from the search with Enter and picks them', async () => {
    sdkMock.createPerson.mockResolvedValue(newPerson('cleo', 'Cleo'));
    renderWithTooltips(AssetTagPeopleModal, { assetIds, onClose });
    await waitFor(() => expect(person('Ann')).toBeInTheDocument());

    await userEvent.type(screen.getByTestId('tag-people-search'), 'Cleo');
    expect(screen.getByTestId('tag-people-create')).toHaveTextContent('Create person "Cleo"');
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByTestId('tag-people-selected')).toHaveTextContent('Cleo'));
    expect(sdkMock.createPerson).toHaveBeenCalledWith({ personCreateDto: { name: 'Cleo' } });
    expect(sdkMock.addPersonToAssets).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('picks the best match with Enter instead of creating a person', async () => {
    sdkMock.getAllPeople.mockResolvedValue({
      people: [newPerson('dana', 'Dana'), newPerson('ann', 'Ann'), newPerson('bob', 'Bob')],
      hasNextPage: false,
      total: 3,
      hidden: 0,
    });
    renderWithTooltips(AssetTagPeopleModal, { assetIds, onClose });
    await waitFor(() => expect(person('Ann')).toBeInTheDocument());

    await userEvent.type(screen.getByTestId('tag-people-search'), 'an{Enter}');

    expect(screen.getByTestId('tag-people-selected')).toHaveTextContent('Ann');
    expect(screen.getByTestId('tag-people-selected')).not.toHaveTextContent('Dana');
    expect(screen.getByTestId('tag-people-search')).toHaveValue('');
    expect(sdkMock.createPerson).not.toHaveBeenCalled();

    await userEvent.type(screen.getByTestId('tag-people-search'), 'an{Enter}');
    expect(screen.getByTestId('tag-people-selected').textContent?.match(/Ann/g)).toHaveLength(1);
  });
});
