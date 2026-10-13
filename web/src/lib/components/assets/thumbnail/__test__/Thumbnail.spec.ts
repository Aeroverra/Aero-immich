import { AssetVisibility } from '@immich/sdk';
import '@testing-library/jest-dom';
import { render } from '@testing-library/svelte';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import Thumbnail from '$lib/components/assets/thumbnail/Thumbnail.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { getTabbable } from '$lib/utils/focus-util';
import { assetFactory, timelineAssetFactory } from '@test-data/factories/asset-factory';

vi.mock('$lib/utils/navigation', () => ({
  currentUrlReplaceAssetId: vi.fn(),
  isSharedLinkRoute: vi.fn().mockReturnValue(false),
}));

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    enumerable: true,
    value: vi.fn().mockImplementation(function (query) {
      return {
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(), // deprecated
        removeListener: vi.fn(), // deprecated
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
});

describe('Thumbnail component', () => {
  beforeAll(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
  });

  it('should only contain a single tabbable element (the container)', () => {
    const asset = assetFactory.build({ originalPath: 'image.jpg', originalMimeType: 'image/jpeg' });
    const { baseElement } = render(Thumbnail, {
      asset,
      selected: true,
    });

    const container = baseElement.querySelector('[data-thumbnail-focus-container]');
    expect(container).not.toBeNull();
    expect(container!.getAttribute('tabindex')).toBe('0');

    // Guarding against inserting extra tabbable elements in future in <Thumbnail/>
    const tabbables = getTabbable(container!);
    expect(tabbables.length).toBe(0);
  });

  it('shows thumbhash while image is loading', () => {
    const asset = assetFactory.build({ originalPath: 'image.jpg', originalMimeType: 'image/jpeg' });
    const sut = render(Thumbnail, {
      asset,
      selected: true,
    });

    const thumbhash = sut.getByTestId('thumbhash');
    expect(thumbhash).not.toBeFalsy();
  });

  describe('private badge', () => {
    it('is not rendered for a non-private asset', () => {
      const asset = timelineAssetFactory.build({ isPrivate: false, isFavorite: false });
      const { baseElement } = render(Thumbnail, { asset });

      expect(baseElement.querySelector('[data-icon-private]')).toBeNull();
    });

    it('is rendered at the bottom for a private asset with no other badges', () => {
      const asset = timelineAssetFactory.build({
        isPrivate: true,
        isFavorite: false,
        visibility: AssetVisibility.Timeline,
      });
      const { baseElement } = render(Thumbnail, { asset });

      const badge = baseElement.querySelector('[data-icon-private]');
      expect(badge).not.toBeNull();
      expect(badge!.parentElement).toHaveClass('bottom-2');
    });

    it('is offset above the favorite badge', () => {
      const asset = timelineAssetFactory.build({
        isPrivate: true,
        isFavorite: true,
        visibility: AssetVisibility.Timeline,
      });
      const { baseElement } = render(Thumbnail, { asset });

      expect(baseElement.querySelector('[data-icon-favorite]')!.parentElement).toHaveClass('bottom-2');
      expect(baseElement.querySelector('[data-icon-private]')!.parentElement).toHaveClass('bottom-10');
    });

    it('is offset above both the favorite and archive badges', () => {
      const asset = timelineAssetFactory.build({
        isPrivate: true,
        isFavorite: true,
        visibility: AssetVisibility.Archive,
      });
      const { baseElement } = render(Thumbnail, { asset, showArchiveIcon: true });

      expect(baseElement.querySelector('[data-icon-favorite]')!.parentElement).toHaveClass('bottom-2');
      expect(baseElement.querySelector('[data-icon-archive]')!.parentElement).toHaveClass('bottom-10');
      expect(baseElement.querySelector('[data-icon-private]')!.parentElement).toHaveClass('bottom-18');
    });

    it('is hidden on shared links', () => {
      Object.defineProperty(authManager, 'isSharedLink', { value: true, configurable: true });
      try {
        const asset = timelineAssetFactory.build({ isPrivate: true, isFavorite: true });
        const { baseElement } = render(Thumbnail, { asset });

        expect(baseElement.querySelector('[data-icon-private]')).toBeNull();
        expect(baseElement.querySelector('[data-icon-favorite]')).toBeNull();
      } finally {
        Reflect.deleteProperty(authManager, 'isSharedLink');
      }
    });
  });
});
