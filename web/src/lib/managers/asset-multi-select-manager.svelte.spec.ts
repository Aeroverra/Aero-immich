import { AssetVisibility } from '@immich/sdk';
import { AssetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

describe('AssetMultiSelectManager', () => {
  let sut: AssetMultiSelectManager;

  beforeEach(() => {
    sut = new AssetMultiSelectManager();
  });

  it('calculates derived values from selection', () => {
    sut.selectAsset(
      timelineAssetFactory.build({ isFavorite: true, visibility: AssetVisibility.Archive, isTrashed: true }),
    );
    sut.selectAsset(
      timelineAssetFactory.build({ isFavorite: true, visibility: AssetVisibility.Timeline, isTrashed: false }),
    );

    expect(sut.selectionActive).toBe(true);
    expect(sut.isAllTrashed).toBe(false);
    expect(sut.isAllArchived).toBe(false);
    expect(sut.isAllFavorite).toBe(true);
  });

  it('tracks private and non-private assets separately so mixed selections can go both ways', () => {
    sut.selectAsset(timelineAssetFactory.build({ isPrivate: true }));
    expect(sut.isAllPrivate).toBe(true);
    expect(sut.hasPrivate).toBe(true);
    expect(sut.hasNonPrivate).toBe(false);

    sut.selectAsset(timelineAssetFactory.build({ isPrivate: false }));
    expect(sut.isAllPrivate).toBe(false);
    expect(sut.hasPrivate).toBe(true);
    expect(sut.hasNonPrivate).toBe(true);
  });

  it('only counts owned assets for hasPrivate and hasNonPrivate', () => {
    const [user, partner] = userAdminFactory.buildList(2);
    sut.selectAsset(timelineAssetFactory.build({ ownerId: user.id, isPrivate: false }));
    sut.selectAsset(timelineAssetFactory.build({ ownerId: partner.id, isPrivate: true }));

    const cleanup = $effect.root(() => {
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build());
      expect(sut.hasNonPrivate).toBe(true);
      expect(sut.hasPrivate).toBe(false);
    });

    cleanup();
    authManager.reset();
  });

  it('updates isAllUserOwned when the active user changes', () => {
    const [user1, user2] = userAdminFactory.buildList(2);
    sut.selectAsset(timelineAssetFactory.build({ ownerId: user1.id }));

    const cleanup = $effect.root(() => {
      expect(sut.isAllUserOwned).toBe(false);

      authManager.setUser(user1);
      authManager.setPreferences(preferencesFactory.build());
      expect(sut.isAllUserOwned).toBe(true);

      authManager.setUser(user2);
      expect(sut.isAllUserOwned).toBe(false);
    });

    cleanup();
    authManager.reset();
  });
});
