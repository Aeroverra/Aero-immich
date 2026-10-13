import { ViewAccess, ViewPrivateAssets, type CustomViewResponseDto } from '@immich/sdk';
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import HiddenAssetViewModal from './HiddenAssetViewModal.svelte';

const newView = (overrides: Partial<CustomViewResponseDto> = {}): CustomViewResponseDto => ({
  id: 'view-1',
  name: 'All',
  order: 0,
  isDefault: false,
  access: ViewAccess.Private,
  includeAll: true,
  includeUntagged: false,
  includeTagIds: [],
  excludeTagIds: [],
  privateAssets: ViewPrivateAssets.Unlocked,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('HiddenAssetViewModal component', () => {
  const onClose = vi.fn();
  const all = newView();
  const gym = newView({ id: 'view-2', name: 'Gym', access: ViewAccess.Locked });

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    vi.resetAllMocks();
    Element.prototype.animate = getAnimateMock();
  });

  afterAll(async () => {
    await waitFor(() => {
      expect(document.body.style.pointerEvents).not.toBe('none');
    });
  });

  it('names the current view and lists the views that show the asset', async () => {
    render(HiddenAssetViewModal, { views: [all, gym], allPhotos: false, currentViewName: 'Default', onClose });

    expect(await screen.findByText(/Your current view, Default, hides this item/)).toBeInTheDocument();
    expect(screen.getByText('Private mode only')).toBeInTheDocument();
    expect(screen.getByText('Requires PIN')).toBeInTheDocument();
    expect(screen.queryByText('All photos')).not.toBeInTheDocument();
  });

  it('closes with the chosen view', async () => {
    const user = userEvent.setup();
    render(HiddenAssetViewModal, { views: [all, gym], allPhotos: true, currentViewName: 'Gym', onClose });

    await user.click(await screen.findByRole('button', { name: /^Gym/ }));
    expect(onClose).toHaveBeenCalledExactlyOnceWith({ view: gym });

    await user.click(screen.getByRole('button', { name: /^All photos/ }));
    expect(onClose).toHaveBeenLastCalledWith({ view: null });
  });

  it('closes without a view when cancelled', async () => {
    const user = userEvent.setup();
    render(HiddenAssetViewModal, { views: [all], allPhotos: false, currentViewName: 'Default', onClose });

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledExactlyOnceWith();
  });
});
