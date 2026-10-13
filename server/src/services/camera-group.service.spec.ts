import {
  AssetType,
  AssetVisibility,
  JobName,
  JobStatus,
  StackSource,
  StackUserEditAction,
  UserMetadataKey,
} from 'src/enum';
import { CAMERA_GROUP_DELAY_MS, CameraGroupService } from 'src/services/camera-group.service';
import { newTestService, ServiceMocks } from 'test/utils';
import { beforeEach, describe, expect, it } from 'vitest';

type Candidate = Awaited<ReturnType<ServiceMocks['stack']['getCameraGroupCandidates']>>[number];

const ownerId = 'owner-1';
const scope = { privateMode: true, userId: ownerId };

const COVER = 'PXL_20250929_175225242.VB-01.COVER.mp4';
const MAIN = 'PXL_20250929_175225242.VB-02.MAIN.mp4';

const candidate = (id: string, originalFileName: string, overrides: Partial<Candidate> = {}): Candidate => ({
  id,
  originalFileName,
  type: originalFileName.endsWith('.mp4') ? AssetType.Video : AssetType.Image,
  visibility: AssetVisibility.Timeline,
  isPrivate: false,
  stackId: null,
  stackPrimaryAssetId: null,
  stackSource: null,
  isExcluded: false,
  ...overrides,
});

describe(CameraGroupService.name, () => {
  let sut: CameraGroupService;
  let mocks: ServiceMocks;

  const mockAsset = (id: string, originalFileName: string) => {
    mocks.asset.getById.mockResolvedValue({ id, ownerId, originalFileName, deletedAt: null } as any);
  };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(CameraGroupService));
    mocks.user.getMetadata.mockResolvedValue([]);
    mocks.stack.create.mockResolvedValue({ id: 'stack-1' } as any);
    mocks.stack.getById.mockResolvedValue({ id: 'stack-1', assets: [] } as any);
    mocks.stack.update.mockResolvedValue({ id: 'stack-1', assets: [] } as any);
    mocks.tag.getAssetTags.mockResolvedValue([]);
    mocks.tag.upsertAssetIds.mockResolvedValue([]);
  });

  describe('onAssetMetadataExtracted', () => {
    it('queues a delayed job for a file of a camera shot', async () => {
      mockAsset('main', MAIN);
      await sut.onAssetMetadataExtracted({ assetId: 'main', userId: ownerId });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.StackCameraGroup,
        data: { id: 'main', delay: CAMERA_GROUP_DELAY_MS },
      });
    });

    it('does nothing for other files', async () => {
      mockAsset('photo', 'IMG_1234.JPG');
      await sut.onAssetMetadataExtracted({ assetId: 'photo', userId: ownerId });
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('handleStackCameraGroup', () => {
    it('stacks a Video Boost pair from different folders with the MAIN on top', async () => {
      mockAsset('cover', COVER);
      mocks.stack.getCameraGroupCandidates.mockResolvedValue([candidate('cover', COVER), candidate('main', MAIN)]);

      await expect(sut.handleStackCameraGroup({ id: 'cover' })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.getCameraGroupCandidates).toHaveBeenCalledWith(ownerId, 'PXL_20250929_175225242.VB-%');
      expect(mocks.stack.create).toHaveBeenCalledWith(
        { ownerId, source: StackSource.Manual },
        ['main', 'cover'],
        scope,
      );
      expect(mocks.event.emit).toHaveBeenCalledWith('StackCreate', { stackId: 'stack-1', userId: ownerId });
    });

    it('does nothing when the user turned it off', async () => {
      mockAsset('cover', COVER);
      mocks.user.getMetadata.mockResolvedValue([
        { key: UserMetadataKey.Preferences, value: { cameraGroups: { enabled: false } } },
      ]);
      await expect(sut.handleStackCameraGroup({ id: 'cover' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.stack.getCameraGroupCandidates).not.toHaveBeenCalled();
    });

    it('does nothing while the other file of the pair is missing', async () => {
      mockAsset('cover', COVER);
      mocks.stack.getCameraGroupCandidates.mockResolvedValue([candidate('cover', COVER)]);
      await expect(sut.handleStackCameraGroup({ id: 'cover' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it('ignores other names the pattern finds', async () => {
      mockAsset('cover', COVER);
      mocks.stack.getCameraGroupCandidates.mockResolvedValue([
        candidate('cover', COVER),
        candidate('copy', 'PXL_20250929_175225242.VB-02.MAIN~2.mp4'),
      ]);
      await expect(sut.handleStackCameraGroup({ id: 'cover' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it('does nothing when the pair is already stacked', async () => {
      mockAsset('cover', COVER);
      mocks.stack.getCameraGroupCandidates.mockResolvedValue([
        candidate('cover', COVER, { stackId: 'stack-1', stackPrimaryAssetId: 'main', stackSource: StackSource.Manual }),
        candidate('main', MAIN, { stackId: 'stack-1', stackPrimaryAssetId: 'main', stackSource: StackSource.Manual }),
      ]);
      await expect(sut.handleStackCameraGroup({ id: 'cover' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.stack.create).not.toHaveBeenCalled();
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });

    it('leaves files the user unstacked alone', async () => {
      mockAsset('cover', COVER);
      mocks.stack.getCameraGroupCandidates.mockResolvedValue([
        candidate('cover', COVER, { isExcluded: true }),
        candidate('main', MAIN, { isExcluded: true }),
      ]);
      await expect(sut.handleStackCameraGroup({ id: 'cover' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it('leaves locked files alone', async () => {
      mockAsset('cover', COVER);
      mocks.stack.getCameraGroupCandidates.mockResolvedValue([
        candidate('cover', COVER),
        candidate('main', MAIN, { visibility: AssetVisibility.Locked }),
      ]);
      await expect(sut.handleStackCameraGroup({ id: 'cover' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it('leaves a pair split between the timeline and the archive alone', async () => {
      mockAsset('cover', COVER);
      mocks.stack.getCameraGroupCandidates.mockResolvedValue([
        candidate('cover', COVER),
        candidate('main', MAIN, { visibility: AssetVisibility.Archive }),
      ]);
      await expect(sut.handleStackCameraGroup({ id: 'cover' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it('leaves files in an automatic stack alone', async () => {
      const name = 'PXL_20240411_181110948.LONG_EXPOSURE-01.COVER.jpg';
      mockAsset('cover', name);
      mocks.stack.getCameraGroupCandidates.mockResolvedValue([
        candidate('cover', name, { stackId: 'auto', stackPrimaryAssetId: 'x', stackSource: StackSource.Auto }),
        candidate('original', 'PXL_20240411_181110948.LONG_EXPOSURE-02.ORIGINAL.jpg'),
      ]);
      await expect(sut.handleStackCameraGroup({ id: 'cover' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it('leaves files in two stacks alone when a stack holds other files', async () => {
      mockAsset('cover', COVER);
      mocks.stack.getCameraGroupCandidates.mockResolvedValue([
        candidate('cover', COVER, { stackId: 'a', stackPrimaryAssetId: 'cover', stackSource: StackSource.Manual }),
        candidate('main', MAIN, { stackId: 'b', stackPrimaryAssetId: 'main', stackSource: StackSource.Manual }),
      ]);
      mocks.stack.getForUserEdit.mockResolvedValue([
        { id: 'a', primaryAssetId: 'cover', source: StackSource.Manual, assets: [{ id: 'cover' }, { id: 'other' }] },
        { id: 'b', primaryAssetId: 'main', source: StackSource.Manual, assets: [{ id: 'main' }] },
      ]);
      await expect(sut.handleStackCameraGroup({ id: 'cover' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.stack.getForUserEdit).toHaveBeenCalledWith({ stackIds: expect.arrayContaining(['a', 'b']) });
      expect(mocks.stack.create).not.toHaveBeenCalled();
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });

    it('merges the stacks an import left a burst in, with the cover frame on top', async () => {
      const cover = '00000IMG_00000_BURST20190530194629_COVER.jpg';
      mockAsset('cover', cover);
      mocks.stack.getCameraGroupCandidates.mockResolvedValue([
        candidate('cover', cover, { stackId: 'a', stackPrimaryAssetId: 'cover', stackSource: StackSource.Manual }),
        candidate('frame-1', '00001IMG_00001_BURST20190530194629.jpg', {
          stackId: 'b',
          stackPrimaryAssetId: 'frame-1',
          stackSource: StackSource.Manual,
        }),
        candidate('frame-2', '00002IMG_00002_BURST20190530194629.jpg', {
          stackId: 'b',
          stackPrimaryAssetId: 'frame-1',
          stackSource: StackSource.Manual,
        }),
      ]);
      mocks.stack.getForUserEdit.mockResolvedValue([
        { id: 'a', primaryAssetId: 'cover', source: StackSource.Manual, assets: [{ id: 'cover' }] },
        {
          id: 'b',
          primaryAssetId: 'frame-1',
          source: StackSource.Manual,
          assets: [{ id: 'frame-1' }, { id: 'frame-2' }],
        },
      ]);

      await expect(sut.handleStackCameraGroup({ id: 'cover' })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.create).toHaveBeenCalledWith(
        { ownerId, source: StackSource.Manual },
        ['cover', 'frame-1', 'frame-2'],
        scope,
      );
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'StackUserEdit',
        expect.objectContaining({ stackId: 'b', action: StackUserEditAction.Merge, targetStackId: 'stack-1' }),
      );
    });

    it('adds a late burst cover on top of the stack of its frames', async () => {
      const cover = '00000IMG_00000_BURST20190530194629_COVER.jpg';
      const inStack = { stackId: 'burst', stackPrimaryAssetId: 'frame-1', stackSource: StackSource.Manual };
      mockAsset('cover', cover);
      mocks.stack.getCameraGroupCandidates.mockResolvedValue([
        candidate('frame-1', '00001IMG_00001_BURST20190530194629.jpg', inStack),
        candidate('frame-2', '00002IMG_00002_BURST20190530194629.jpg', inStack),
        candidate('cover', cover),
      ]);

      await expect(sut.handleStackCameraGroup({ id: 'cover' })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.getCameraGroupCandidates).toHaveBeenCalledWith(ownerId, '%BURST20190530194629%');
      expect(mocks.asset.updateAll).toHaveBeenCalledWith(['cover'], { stackId: 'burst' });
      expect(mocks.stack.update).toHaveBeenCalledWith('burst', { primaryAssetId: 'cover' }, scope);
      expect(mocks.event.emit).toHaveBeenCalledWith('StackUpdate', { stackId: 'burst', userId: ownerId });
      // burst frames are different photos, their tags are left as they are
      expect(mocks.tag.getAssetTags).not.toHaveBeenCalled();
    });

    it('keeps the top file of a stack when a file that does not belong on top joins it', async () => {
      const inStack = { stackId: 'burst', stackPrimaryAssetId: 'frame-1', stackSource: StackSource.Manual };
      const frame = '00002IMG_00002_BURST20190530194629.jpg';
      mockAsset('frame-2', frame);
      mocks.stack.getCameraGroupCandidates.mockResolvedValue([
        candidate('frame-1', '00001IMG_00001_BURST20190530194629.jpg', inStack),
        candidate('frame-2', frame),
      ]);

      await expect(sut.handleStackCameraGroup({ id: 'frame-2' })).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).toHaveBeenCalledWith(['frame-2'], { stackId: 'burst' });
      expect(mocks.stack.update).not.toHaveBeenCalled();
    });

    it('makes the whole stack private when one file is private', async () => {
      mockAsset('cover', COVER);
      mocks.stack.getCameraGroupCandidates.mockResolvedValue([
        candidate('cover', COVER, { isPrivate: true }),
        candidate('main', MAIN),
      ]);

      await sut.handleStackCameraGroup({ id: 'cover' });

      expect(mocks.asset.updateAll).toHaveBeenCalledWith(['main'], { isPrivate: true });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetPrivateUpdateAll', { assetIds: ['main'], userId: ownerId });
    });

    it('gives both videos of a pair the same tags', async () => {
      mockAsset('main', MAIN);
      mocks.stack.getCameraGroupCandidates.mockResolvedValue([candidate('cover', COVER), candidate('main', MAIN)]);
      mocks.tag.getAssetTags.mockResolvedValue([
        { assetId: 'cover', id: 'tag-mom', value: 'People/Mom' },
        { assetId: 'cover', id: 'tag-source', value: 'Source/Google Photos/2026-09-07 88tontos' },
        { assetId: 'main', id: 'tag-unreviewed', value: 'Unreviewed' },
      ]);

      await sut.handleStackCameraGroup({ id: 'main' });

      expect(mocks.tag.upsertAssetIds).toHaveBeenCalledWith([{ assetId: 'main', tagId: 'tag-mom' }]);
      expect(mocks.tag.removeAssetIds).toHaveBeenCalledWith('tag-unreviewed', ['main']);
      expect(mocks.event.emit).toHaveBeenCalledTimes(2);
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetTag', { assetId: 'main', userId: ownerId });
    });

    it('does not copy tags when the user turned it off', async () => {
      mockAsset('main', MAIN);
      mocks.user.getMetadata.mockResolvedValue([
        { key: UserMetadataKey.Preferences, value: { cameraGroups: { copyTags: false } } },
      ]);
      mocks.stack.getCameraGroupCandidates.mockResolvedValue([candidate('cover', COVER), candidate('main', MAIN)]);

      await sut.handleStackCameraGroup({ id: 'main' });

      expect(mocks.stack.create).toHaveBeenCalled();
      expect(mocks.tag.getAssetTags).not.toHaveBeenCalled();
    });
  });
});
