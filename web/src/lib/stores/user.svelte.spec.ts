import { eventManager } from '$lib/managers/event-manager.svelte';
import { userInteraction } from '$lib/stores/user.svelte';
import { albumFactory } from '@test-data/factories/album-factory';

describe('userInteraction store', () => {
  it('drops the cached recent albums when private mode changes', () => {
    userInteraction.recentAlbums = albumFactory.buildList(2);

    eventManager.emit('PrivateModeChange', false);

    expect(userInteraction.recentAlbums).toBeUndefined();
  });
});
