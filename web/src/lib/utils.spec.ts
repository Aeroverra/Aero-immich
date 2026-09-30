import { AssetTypeEnum } from '@immich/sdk';
import { AbortError, getAssetUrl, semverToName, uploadRequest } from '$lib/utils';
import { assetFactory } from '@test-data/factories/asset-factory';
import { sharedLinkFactory } from '@test-data/factories/shared-link-factory';

class FakeXhr {
  static instances: FakeXhr[] = [];
  method?: string;
  url?: string;
  responseType = '';
  response: unknown;
  status = 200;
  readyState = 4;
  statusText = 'OK';
  sentBody: unknown;
  requestHeaders: Record<string, string> = {};
  aborted = false;
  upload = { addEventListener: vi.fn() };
  #listeners: Record<string, (event: unknown) => void> = {};

  constructor() {
    FakeXhr.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void) {
    this.#listeners[type] = handler;
  }

  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body: unknown) {
    this.sentBody = body;
  }

  abort() {
    this.aborted = true;
    this.#listeners.abort?.({});
  }

  emitLoad(response: unknown, status = 200) {
    this.status = status;
    this.response = response;
    this.#listeners.load?.({});
  }
}

describe('utils', () => {
  describe(uploadRequest.name, () => {
    beforeEach(() => {
      FakeXhr.instances = [];
      vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('sends custom headers and a Blob body', async () => {
      const blob = new Blob(['chunk'], { type: 'application/octet-stream' });
      const promise = uploadRequest({
        url: '/takeouts/uploads/1',
        method: 'PUT',
        data: blob,
        headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': '10' },
      });

      const xhr = FakeXhr.instances[0];
      expect(xhr.method).toBe('PUT');
      expect(xhr.requestHeaders['Content-Type']).toBe('application/octet-stream');
      expect(xhr.requestHeaders['Upload-Offset']).toBe('10');
      expect(xhr.sentBody).toBe(blob);

      xhr.emitLoad({ offset: 15 });
      await expect(promise).resolves.toEqual({ data: { offset: 15 }, status: 200 });
    });

    it('rejects with AbortError when its signal aborts', async () => {
      const controller = new AbortController();
      const promise = uploadRequest({
        url: '/takeouts/uploads/1',
        method: 'PUT',
        data: new Blob(['x']),
        signal: controller.signal,
      });

      const xhr = FakeXhr.instances[0];
      controller.abort();
      expect(xhr.aborted).toBe(true);
      await expect(promise).rejects.toBeInstanceOf(AbortError);
    });

    it('rejects immediately when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        uploadRequest({ url: '/x', method: 'PUT', data: new Blob(['x']), signal: controller.signal }),
      ).rejects.toBeInstanceOf(AbortError);
    });
  });

  describe(getAssetUrl.name, () => {
    it('should return thumbnail URL for static images', () => {
      const asset = assetFactory.build({
        originalPath: 'image.jpg',
        originalMimeType: 'image/jpeg',
        type: AssetTypeEnum.Image,
      });

      const url = getAssetUrl({ asset });

      // Should return a thumbnail URL (contains /thumbnail)
      expect(url).toContain('/thumbnail');
      expect(url).toContain(asset.id);
    });

    it('should return thumbnail URL for static gifs', () => {
      const asset = assetFactory.build({
        originalPath: 'image.gif',
        originalMimeType: 'image/gif',
        type: AssetTypeEnum.Image,
      });

      const url = getAssetUrl({ asset });

      expect(url).toContain('/thumbnail');
      expect(url).toContain(asset.id);
    });

    it('should return thumbnail URL for static webp images', () => {
      const asset = assetFactory.build({
        originalPath: 'image.webp',
        originalMimeType: 'image/webp',
        type: AssetTypeEnum.Image,
      });

      const url = getAssetUrl({ asset });

      expect(url).toContain('/thumbnail');
      expect(url).toContain(asset.id);
    });

    it('should return original URL for animated gifs', () => {
      const asset = assetFactory.build({
        originalPath: 'image.gif',
        originalMimeType: 'image/gif',
        type: AssetTypeEnum.Image,
        duration: 2000,
      });

      const url = getAssetUrl({ asset });

      // Should return original URL (contains /original)
      expect(url).toContain('/original');
      expect(url).toContain(asset.id);
    });

    it('should return original URL for animated webp images', () => {
      const asset = assetFactory.build({
        originalPath: 'image.webp',
        originalMimeType: 'image/webp',
        type: AssetTypeEnum.Image,
        duration: 2000,
      });

      const url = getAssetUrl({ asset });

      expect(url).toContain('/original');
      expect(url).toContain(asset.id);
    });

    it('should return original URL for video assets with forceOriginal', () => {
      const asset = assetFactory.build({
        originalPath: 'video.mp4',
        originalMimeType: 'video/mp4',
        type: AssetTypeEnum.Video,
      });

      const url = getAssetUrl({ asset, forceOriginal: true });

      expect(url).toContain('/original');
      expect(url).toContain(asset.id);
    });

    it('should return thumbnail URL for video assets without forceOriginal', () => {
      const asset = assetFactory.build({
        originalPath: 'video.mp4',
        originalMimeType: 'video/mp4',
        type: AssetTypeEnum.Video,
      });

      const url = getAssetUrl({ asset });

      expect(url).toContain('/thumbnail');
      expect(url).toContain(asset.id);
    });

    it('should return thumbnail URL for static images in shared link even with download and showMetadata permissions', () => {
      const asset = assetFactory.build({
        originalPath: 'image.gif',
        originalMimeType: 'image/gif',
        type: AssetTypeEnum.Image,
      });
      const sharedLink = sharedLinkFactory.build({ allowDownload: true, showMetadata: true, assets: [asset] });

      const url = getAssetUrl({ asset, sharedLink });

      expect(url).toContain('/thumbnail');
      expect(url).toContain(asset.id);
    });

    it('should return original URL for animated images in shared link with download and showMetadata permissions', () => {
      const asset = assetFactory.build({
        originalPath: 'image.gif',
        originalMimeType: 'image/gif',
        type: AssetTypeEnum.Image,
        duration: 2000,
      });
      const sharedLink = sharedLinkFactory.build({ allowDownload: true, showMetadata: true, assets: [asset] });

      const url = getAssetUrl({ asset, sharedLink });

      expect(url).toContain('/original');
      expect(url).toContain(asset.id);
    });

    it('should return thumbnail URL (not original) for animated images when shared link download permission is false', () => {
      const asset = assetFactory.build({
        originalPath: 'image.gif',
        originalMimeType: 'image/gif',
        type: AssetTypeEnum.Image,
        duration: 2000,
      });
      const sharedLink = sharedLinkFactory.build({ allowDownload: false, assets: [asset] });

      const url = getAssetUrl({ asset, sharedLink });

      expect(url).toContain('/thumbnail');
      expect(url).not.toContain('/original');
      expect(url).toContain(asset.id);
    });

    it('should return thumbnail URL (not original) for animated images when shared link showMetadata permission is false', () => {
      const asset = assetFactory.build({
        originalPath: 'image.gif',
        originalMimeType: 'image/gif',
        type: AssetTypeEnum.Image,
        duration: 2000,
      });
      const sharedLink = sharedLinkFactory.build({ showMetadata: false, assets: [asset] });

      const url = getAssetUrl({ asset, sharedLink });

      expect(url).toContain('/thumbnail');
      expect(url).not.toContain('/original');
      expect(url).toContain(asset.id);
    });
  });
  describe('semverToName', () => {
    it('should not append release candidate tag if prelease is not set', () => {
      expect(semverToName({ major: 3, minor: 0, patch: 0, prerelease: null })).toEqual('v3.0.0');
    });

    it('should append release candidate if set', () => {
      expect(semverToName({ major: 3, minor: 0, patch: 0, prerelease: 0 })).toEqual('v3.0.0-rc.0');
    });
  });
});
