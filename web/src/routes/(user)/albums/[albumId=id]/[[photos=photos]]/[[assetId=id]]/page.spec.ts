import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
import { albumFactory } from '@test-data/factories/album-factory';
import { load } from './+page';

vi.mock('$lib/utils/auth', () => ({
  authenticate: vi.fn(),
}));

describe('album page load', () => {
  const event = {
    params: { albumId: 'album-1' },
    url: new URL('http://localhost/albums/album-1'),
    depends: vi.fn(),
  } as unknown as Parameters<typeof load>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    privateModeManager.enabled = false;
    sdkMock.isHttpError.mockImplementation(
      (error: unknown) => !!error && typeof error === 'object' && 'status' in error,
    );
  });

  afterEach(() => {
    privateModeManager.enabled = false;
  });

  it('returns the album', async () => {
    const album = albumFactory.build();
    sdkMock.getAlbumInfo.mockResolvedValue(album);

    await expect(load(event)).resolves.toEqual({ album, meta: { title: album.albumName } });
  });

  it('redirects to the albums list when a hidden private album is requested with the mode off', async () => {
    sdkMock.getAlbumInfo.mockRejectedValue({ status: 400, message: 'Bad Request' });

    await expect(load(event)).rejects.toMatchObject({ status: 307, location: '/albums' });
  });

  it('surfaces other errors', async () => {
    sdkMock.getAlbumInfo.mockRejectedValue({ status: 404, message: 'Not Found' });

    await expect(load(event)).rejects.toMatchObject({ status: 404 });
  });

  it('surfaces a 400 while the mode is on', async () => {
    privateModeManager.enabled = true;
    sdkMock.getAlbumInfo.mockRejectedValue({ status: 400, message: 'Bad Request' });

    await expect(load(event)).rejects.toMatchObject({ status: 400 });
  });
});
