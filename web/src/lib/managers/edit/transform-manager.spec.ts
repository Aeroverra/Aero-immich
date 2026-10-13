import { AssetEditAction, AssetTypeEnum } from '@immich/sdk';
import { isRotateOnlyAsset, transformManager } from '$lib/managers/edit/transform-manager.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';

describe('TransformManager', () => {
  afterEach(() => {
    transformManager.reset();
  });

  describe('isRotateOnlyAsset', () => {
    it('should only rotate videos and motion photos', () => {
      expect(isRotateOnlyAsset(assetFactory.build({ type: AssetTypeEnum.Video }))).toBe(true);
      expect(isRotateOnlyAsset(assetFactory.build({ type: AssetTypeEnum.Image, livePhotoVideoId: 'motion-1' }))).toBe(
        true,
      );
      expect(isRotateOnlyAsset(assetFactory.build({ type: AssetTypeEnum.Image, livePhotoVideoId: null }))).toBe(false);
    });
  });

  describe('getEdits', () => {
    it('should only save the rotation of a video', () => {
      transformManager.rotateOnly = true;
      transformManager.imageRotation = -90;
      transformManager.mirrorHorizontal = true;
      transformManager.region = { x: 10, y: 10, width: 20, height: 20 };

      expect(transformManager.getEdits()).toEqual([{ action: AssetEditAction.Rotate, parameters: { angle: 270 } }]);
    });

    it('should save nothing for a video turned back upright', () => {
      transformManager.rotateOnly = true;
      transformManager.imageRotation = 360;

      expect(transformManager.getEdits()).toEqual([]);
    });
  });
});
