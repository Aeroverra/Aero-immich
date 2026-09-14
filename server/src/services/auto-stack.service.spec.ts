import {
  AssetType,
  AssetVisibility,
  JobName,
  JobStatus,
  StackAutoExclusionReason,
  StackSource,
  StackUserEditAction,
  UserMetadataKey,
} from 'src/enum';
import { AutoStackService } from 'src/services/auto-stack.service';
import { makeStream, newTestService, ServiceMocks } from 'test/utils';
import { beforeEach, describe, expect, it, vitest } from 'vitest';

vitest.useFakeTimers({ now: new Date('2026-09-14T12:00:00.000Z') });

type Candidate = Awaited<ReturnType<ServiceMocks['autoStack']['getCandidates']>>[number];

const ownerId = 'owner-1';
const burstStart = new Date('2026-09-10T10:00:00.000Z').getTime();

const enabledConfig = {
  machineLearning: {
    enabled: true,
    clip: { enabled: true },
    autoStack: { enabled: true },
    facialRecognition: { enabled: true },
    faceAttributes: { enabled: true },
  },
};

const preferences = (enabled: boolean) => [{ key: UserMetadataKey.Preferences, value: { autoStack: { enabled } } }];

const candidate = (id: string, seconds: number, overrides: Partial<Candidate> = {}): Candidate => ({
  id,
  type: AssetType.Image,
  visibility: AssetVisibility.Timeline,
  isFavorite: false,
  isPrivate: false,
  stackId: null,
  originalFileName: `PXL_${id}.jpg`,
  fileCreatedAt: new Date(burstStart + seconds * 1000),
  createdAt: new Date('2026-09-11T00:00:00.000Z'),
  make: 'Google',
  model: 'Pixel 9 Pro XL',
  embedding: '[1,0,0]',
  facesRecognizedAt: new Date('2026-09-11T00:00:00.000Z'),
  autoStackedAt: null,
  sharpness: 100,
  exposureClipped: 0.01,
  hasQuality: true,
  isExcluded: false,
  isInUserStack: false,
  faces: [],
  ...overrides,
});

const jobAsset = (id: string, seconds: number) => ({
  id,
  ownerId,
  stackSource: null as StackSource | null,
  type: AssetType.Image,
  visibility: AssetVisibility.Timeline,
  deletedAt: null,
  fileCreatedAt: new Date(burstStart + seconds * 1000),
  make: 'Google',
  model: 'Pixel 9 Pro XL',
  autoStackedAt: null,
});

describe(AutoStackService.name, () => {
  let sut: AutoStackService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AutoStackService));
    mocks.systemMetadata.get.mockResolvedValue(enabledConfig);
    mocks.user.getMetadata.mockResolvedValue(preferences(true));
    mocks.stack.create.mockResolvedValue({ id: 'new-stack' } as any);
    mocks.stack.deleteAll.mockResolvedValue();
    mocks.autoStack.setAutoStackedAt.mockResolvedValue();
    mocks.autoStack.resetAutoStackedAt.mockResolvedValue();
    mocks.autoStack.updatePrimaryAsset.mockResolvedValue();
    mocks.autoStack.upsertExclusions.mockResolvedValue();
    mocks.asset.updateAll.mockResolvedValue();
    mocks.event.emit.mockResolvedValue();
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('handleQueueAutoStack', () => {
    it('should skip when automatic stacks are disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { autoStack: { enabled: false } } });

      await expect(sut.handleQueueAutoStack({ force: false })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.autoStack.streamForAutoStack).not.toHaveBeenCalled();
    });

    it('should skip when smart search is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { clip: { enabled: false } } });

      await expect(sut.handleQueueAutoStack({ force: false })).resolves.toBe(JobStatus.Skipped);
    });

    it('should queue the assets that were not evaluated', async () => {
      mocks.autoStack.streamForAutoStack.mockReturnValue(makeStream([{ id: 'asset-1' }, { id: 'asset-2' }]));

      await expect(sut.handleQueueAutoStack({ force: false })).resolves.toBe(JobStatus.Success);

      expect(mocks.autoStack.resetAutoStackedAt).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AutoStack, data: { id: 'asset-1' } },
        { name: JobName.AutoStack, data: { id: 'asset-2' } },
      ]);
    });

    it('should evaluate every asset again when forced', async () => {
      mocks.autoStack.streamForAutoStack.mockReturnValue(makeStream([{ id: 'asset-1' }]));

      await expect(sut.handleQueueAutoStack({ force: true })).resolves.toBe(JobStatus.Success);

      expect(mocks.autoStack.resetAutoStackedAt).toHaveBeenCalled();
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.AutoStack, data: { id: 'asset-1' } }]);
    });
  });

  describe('handleAutoStack', () => {
    it('should skip when automatic stacks are disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { autoStack: { enabled: false } } });

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.autoStack.getForAutoStackJob).not.toHaveBeenCalled();
    });

    it('should skip a missing asset', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(void 0);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);
    });

    it('should skip an asset that was evaluated with a neighbour', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue({ ...jobAsset('asset-1', 0), autoStackedAt: new Date() });

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.autoStack.getCandidates).not.toHaveBeenCalled();
    });

    it('should skip when the owner did not turn automatic stacks on', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.user.getMetadata.mockResolvedValue(preferences(false));

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.autoStack.getCandidates).not.toHaveBeenCalled();
      expect(mocks.autoStack.setAutoStackedAt).not.toHaveBeenCalled();
    });

    it.each([
      { type: AssetType.Video },
      { visibility: AssetVisibility.Locked },
      { visibility: AssetVisibility.Hidden },
      { make: null },
      { deletedAt: new Date() },
    ])('should mark an asset that can never be stacked as evaluated: %o', async (overrides) => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue({ ...jobAsset('asset-1', 0), ...overrides } as any);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.autoStack.getCandidates).not.toHaveBeenCalled();
      expect(mocks.autoStack.setAutoStackedAt).toHaveBeenCalledWith(['asset-1'], expect.any(Date));
    });

    it('should create a stack with the top pick first and mark the neighbourhood as evaluated', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0),
        candidate('asset-2', 1, { isFavorite: true }),
        candidate('asset-3', 2),
        candidate('other-scene', 3, { embedding: '[0,1,0]' }),
        candidate('later', 60),
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.autoStack.getCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId, make: 'Google', model: 'Pixel 9 Pro XL' }),
      );
      expect(mocks.stack.create).toHaveBeenCalledTimes(1);
      expect(mocks.stack.create).toHaveBeenCalledWith(
        { ownerId, source: StackSource.Auto },
        ['asset-2', 'asset-1', 'asset-3'],
        { privateMode: true, userId: ownerId },
      );
      expect(mocks.stack.deleteAll).not.toHaveBeenCalled();
      // the photo 57 seconds later is in another neighbourhood
      expect(mocks.autoStack.setAutoStackedAt).toHaveBeenCalledWith(
        ['asset-1', 'asset-2', 'asset-3', 'other-scene'],
        expect.any(Date),
      );
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_asset_stack_update', ownerId);
    });

    it('should widen the window while photos keep following each other', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      const series = Array.from({ length: 30 }, (_, index) => candidate(`asset-${index + 1}`, index * 4));
      mocks.autoStack.getCandidates.mockImplementation(({ from, to }) =>
        Promise.resolve(
          series.filter(
            ({ fileCreatedAt }) => fileCreatedAt.getTime() >= from.getTime() && fileCreatedAt.getTime() <= to.getTime(),
          ),
        ),
      );

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.autoStack.getCandidates.mock.calls.length).toBeGreaterThan(1);
      expect(mocks.autoStack.setAutoStackedAt).toHaveBeenCalledWith(
        series.map(({ id }) => id),
        expect.any(Date),
      );
      // 4 seconds apart: 8 photos fit in 30 seconds
      expect(mocks.stack.create).toHaveBeenCalledTimes(4);
    });

    it('should wait for a recent neighbour that is still being processed', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0),
        candidate('asset-2', 1, { embedding: null, createdAt: new Date('2026-09-14T11:59:00.000Z') }),
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.stack.create).not.toHaveBeenCalled();
      expect(mocks.autoStack.setAutoStackedAt).not.toHaveBeenCalled();
    });

    it('should wait for the faces of a recent neighbour', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0),
        candidate('asset-2', 1, { facesRecognizedAt: null, createdAt: new Date('2026-09-14T11:59:00.000Z') }),
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);
    });

    it('should wait for the face attributes of a recent neighbour', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0),
        candidate('asset-2', 1, { hasQuality: false, createdAt: new Date('2026-09-14T11:59:00.000Z') }),
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);
    });

    it('should not wait for face attributes that are turned off', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { ...enabledConfig.machineLearning, faceAttributes: { enabled: false } },
      });
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0, { hasQuality: false, createdAt: new Date('2026-09-14T11:59:00.000Z') }),
        candidate('asset-2', 1, { hasQuality: false, createdAt: new Date('2026-09-14T11:59:00.000Z') }),
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.create).toHaveBeenCalledTimes(1);
    });

    it('should stack old photos whose face attributes are missing', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0, { hasQuality: false, sharpness: null, exposureClipped: null }),
        candidate('asset-2', 1, { hasQuality: false, sharpness: null, exposureClipped: null }),
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.create).toHaveBeenCalledTimes(1);
      expect(mocks.autoStack.setAutoStackedAt).toHaveBeenCalledWith(['asset-1', 'asset-2'], expect.any(Date));
    });

    it('should pick the photo with open eyes as the cover', async () => {
      const face = {
        detected: true,
        eyeBlinkLeft: 0.05,
        eyeBlinkRight: 0.05,
        smile: 0.4,
        yaw: 2,
        sharpness: 80,
        personGroupId: 'person-1',
        imageWidth: 1000,
        imageHeight: 1000,
        boundingBoxX1: 400,
        boundingBoxY1: 400,
        boundingBoxX2: 600,
        boundingBoxY2: 600,
      };
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('blink', 0, { sharpness: 300, faces: [{ ...face, eyeBlinkLeft: 0.9, sharpness: 200 }] }),
        candidate('open', 1, { sharpness: 100, faces: [face] }),
        candidate('blurry', 2, { sharpness: 20, faces: [{ ...face, sharpness: 10 }] }),
      ]);
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('blink', 0));

      await expect(sut.handleAutoStack({ id: 'blink' })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.create).toHaveBeenCalledWith(
        expect.anything(),
        ['open', 'blink', 'blurry'],
        expect.anything(),
      );
    });

    it('should evaluate an asset of an automatic stack again when its attributes were refreshed', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue({
        ...jobAsset('asset-1', 0),
        autoStackedAt: new Date(),
        stackSource: StackSource.Auto,
      });
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0, { stackId: 'auto-stack', sharpness: 10 }),
        candidate('asset-2', 1, { stackId: 'auto-stack', sharpness: 500 }),
      ]);
      mocks.autoStack.getStacks.mockResolvedValue([
        { id: 'auto-stack', primaryAssetId: 'asset-1', assets: [{ id: 'asset-1' }, { id: 'asset-2' }] },
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1', refresh: true })).resolves.toBe(JobStatus.Success);

      expect(mocks.autoStack.updatePrimaryAsset).toHaveBeenCalledWith('auto-stack', 'asset-2');
    });

    it('should not refresh an evaluated asset outside automatic stacks', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue({
        ...jobAsset('asset-1', 0),
        autoStackedAt: new Date(),
        stackSource: StackSource.Manual,
      });

      await expect(sut.handleAutoStack({ id: 'asset-1', refresh: true })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.autoStack.getCandidates).not.toHaveBeenCalled();
    });

    it('should not wait for faces when facial recognition is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { ...enabledConfig.machineLearning, facialRecognition: { enabled: false } },
      });
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0, { facesRecognizedAt: null }),
        candidate('asset-2', 1, { facesRecognizedAt: null }),
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.create).toHaveBeenCalledTimes(1);
    });

    it('should not wait for an old neighbour that never got an embedding', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0),
        candidate('asset-2', 1),
        candidate('broken', 2, { embedding: null }),
        candidate('asset-3', 3),
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.create).toHaveBeenCalledWith(expect.anything(), ['asset-1', 'asset-2'], expect.anything());
      expect(mocks.autoStack.setAutoStackedAt).toHaveBeenCalledWith(
        ['asset-1', 'asset-2', 'asset-3'],
        expect.any(Date),
      );
    });

    it('should leave locked assets and their stacks alone', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0),
        candidate('manual-1', 1, { isInUserStack: true, stackId: 'manual-stack' }),
        candidate('manual-2', 2, { isInUserStack: true, stackId: 'manual-stack' }),
        candidate('edited', 3, { isExcluded: true, stackId: 'edited-stack' }),
        candidate('asset-2', 4, { embedding: '[0,1,0]' }),
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.autoStack.getStacks).not.toHaveBeenCalled();
      expect(mocks.stack.create).not.toHaveBeenCalled();
      expect(mocks.stack.deleteAll).not.toHaveBeenCalled();
      expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
    });

    it('should never touch a version stack or add its members to an automatic stack', async () => {
      // the repository reports every stack whose source is not auto (manual, version) as a user stack
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0),
        candidate('boosted', 1, { isInUserStack: true, stackId: 'version-stack' }),
        candidate('original', 2, { isInUserStack: true, stackId: 'version-stack' }),
        candidate('asset-2', 3),
        candidate('asset-3', 4),
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.autoStack.getStacks).not.toHaveBeenCalled();
      expect(mocks.stack.deleteAll).not.toHaveBeenCalled();
      expect(mocks.autoStack.updatePrimaryAsset).not.toHaveBeenCalled();
      expect(mocks.stack.create).toHaveBeenCalledTimes(1);
      expect(mocks.stack.create).toHaveBeenCalledWith(expect.anything(), ['asset-2', 'asset-3'], expect.anything());
    });

    it('should ignore a photo the user took out of a stack and stack its neighbours', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0),
        candidate('removed', 1, { isExcluded: true }),
        candidate('asset-2', 2),
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.create).toHaveBeenCalledWith(expect.anything(), ['asset-1', 'asset-2'], expect.anything());
      expect(mocks.autoStack.setAutoStackedAt).toHaveBeenCalledWith(
        ['asset-1', 'removed', 'asset-2'],
        expect.any(Date),
      );
    });

    it('should keep an automatic stack that still matches', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0, { stackId: 'auto-stack' }),
        candidate('asset-2', 1, { stackId: 'auto-stack' }),
      ]);
      mocks.autoStack.getStacks.mockResolvedValue([
        { id: 'auto-stack', primaryAssetId: 'asset-1', assets: [{ id: 'asset-1' }, { id: 'asset-2' }] },
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.autoStack.getStacks).toHaveBeenCalledWith(['auto-stack']);
      expect(mocks.stack.create).not.toHaveBeenCalled();
      expect(mocks.stack.deleteAll).not.toHaveBeenCalled();
      expect(mocks.autoStack.updatePrimaryAsset).not.toHaveBeenCalled();
      expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
    });

    it('should move the cover of an automatic stack to the new top pick', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0, { stackId: 'auto-stack' }),
        candidate('asset-2', 1, { stackId: 'auto-stack', isFavorite: true }),
      ]);
      mocks.autoStack.getStacks.mockResolvedValue([
        { id: 'auto-stack', primaryAssetId: 'asset-1', assets: [{ id: 'asset-1' }, { id: 'asset-2' }] },
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.autoStack.updatePrimaryAsset).toHaveBeenCalledWith('auto-stack', 'asset-2');
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it('should replace an automatic stack when a late upload joins the burst', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('late', 1));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0, { stackId: 'auto-stack' }),
        candidate('late', 1),
        candidate('asset-2', 2, { stackId: 'auto-stack' }),
      ]);
      mocks.autoStack.getStacks.mockResolvedValue([
        { id: 'auto-stack', primaryAssetId: 'asset-1', assets: [{ id: 'asset-1' }, { id: 'asset-2' }] },
      ]);

      await expect(sut.handleAutoStack({ id: 'late' })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.deleteAll).toHaveBeenCalledWith(['auto-stack']);
      expect(mocks.stack.create).toHaveBeenCalledWith(
        { ownerId, source: StackSource.Auto },
        ['late', 'asset-1', 'asset-2'],
        expect.anything(),
      );
    });

    it('should make every member private when one of them is', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0),
        candidate('asset-2', 1, { isPrivate: true }),
        candidate('asset-3', 2),
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).toHaveBeenCalledWith(['asset-1', 'asset-3'], { isPrivate: true });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetPrivateUpdateAll', {
        assetIds: ['asset-1', 'asset-3'],
        userId: ownerId,
      });
    });

    it('should not touch the private flag of a public stack', async () => {
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([candidate('asset-1', 0), candidate('asset-2', 1)]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should split on a person appearing', async () => {
      const face = {
        detected: true,
        eyeBlinkLeft: 0.1,
        eyeBlinkRight: 0.1,
        smile: 0.5,
        yaw: 0,
        sharpness: 100,
        personGroupId: 'person-1',
        imageWidth: 1000,
        imageHeight: 1000,
        boundingBoxX1: 400,
        boundingBoxY1: 400,
        boundingBoxX2: 600,
        boundingBoxY2: 600,
      };
      mocks.autoStack.getForAutoStackJob.mockResolvedValue(jobAsset('asset-1', 0));
      mocks.autoStack.getCandidates.mockResolvedValue([
        candidate('asset-1', 0, { faces: [face] }),
        candidate('asset-2', 1, { faces: [face] }),
        candidate('asset-3', 2, {
          faces: [face, { ...face, personGroupId: 'person-2', boundingBoxX1: 50, boundingBoxX2: 150 }],
        }),
        candidate('asset-4', 3, {
          faces: [face, { ...face, personGroupId: 'person-2', boundingBoxX1: 50, boundingBoxX2: 150 }],
        }),
      ]);

      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.create).toHaveBeenCalledTimes(2);
      expect(mocks.stack.create).toHaveBeenCalledWith(expect.anything(), ['asset-1', 'asset-2'], expect.anything());
      expect(mocks.stack.create).toHaveBeenCalledWith(expect.anything(), ['asset-3', 'asset-4'], expect.anything());
    });
  });

  describe('onStackUserEdit', () => {
    it('should exclude the members of a deleted stack', async () => {
      await sut.onStackUserEdit({
        userId: ownerId,
        stackId: 'stack-1',
        source: StackSource.Auto,
        action: StackUserEditAction.Delete,
        assetIds: ['asset-1', 'asset-2'],
      });

      expect(mocks.autoStack.upsertExclusions).toHaveBeenCalledWith([
        { assetId: 'asset-1', ownerId, reason: StackAutoExclusionReason.Unstacked },
        { assetId: 'asset-2', ownerId, reason: StackAutoExclusionReason.Unstacked },
      ]);
    });

    it('should exclude the members of a deleted manual stack too', async () => {
      await sut.onStackUserEdit({
        userId: ownerId,
        stackId: 'stack-1',
        source: StackSource.Manual,
        action: StackUserEditAction.Delete,
        assetIds: ['asset-1'],
      });

      expect(mocks.autoStack.upsertExclusions).toHaveBeenCalledWith([
        { assetId: 'asset-1', ownerId, reason: StackAutoExclusionReason.Unstacked },
      ]);
    });

    it('should exclude assets taken out of a stack', async () => {
      await sut.onStackUserEdit({
        userId: ownerId,
        stackId: 'stack-1',
        source: StackSource.Auto,
        action: StackUserEditAction.RemoveAssets,
        assetIds: ['asset-2'],
      });

      expect(mocks.autoStack.upsertExclusions).toHaveBeenCalledWith([
        { assetId: 'asset-2', ownerId, reason: StackAutoExclusionReason.Removed },
      ]);
    });

    it('should protect an automatic stack whose cover the user picked', async () => {
      mocks.autoStack.getStackAssetIds.mockResolvedValue([
        { id: 'asset-1', ownerId },
        { id: 'asset-2', ownerId },
      ]);

      await sut.onStackUserEdit({
        userId: ownerId,
        stackId: 'stack-1',
        source: StackSource.Auto,
        action: StackUserEditAction.UpdatePrimary,
        assetIds: ['asset-2'],
      });

      expect(mocks.autoStack.getStackAssetIds).toHaveBeenCalledWith('stack-1');
      expect(mocks.autoStack.upsertExclusions).toHaveBeenCalledWith([
        { assetId: 'asset-1', ownerId, reason: StackAutoExclusionReason.Edited },
        { assetId: 'asset-2', ownerId, reason: StackAutoExclusionReason.Edited },
      ]);
    });

    it('should ignore a new cover of a manual stack', async () => {
      await sut.onStackUserEdit({
        userId: ownerId,
        stackId: 'stack-1',
        source: StackSource.Manual,
        action: StackUserEditAction.UpdatePrimary,
        assetIds: ['asset-2'],
      });

      expect(mocks.autoStack.upsertExclusions).not.toHaveBeenCalled();
    });

    it('should ignore a merge into a stack the user made', async () => {
      await sut.onStackUserEdit({
        userId: ownerId,
        stackId: 'stack-1',
        source: StackSource.Auto,
        action: StackUserEditAction.Merge,
        assetIds: ['asset-1', 'asset-2'],
        targetStackId: 'stack-2',
      });

      expect(mocks.autoStack.upsertExclusions).not.toHaveBeenCalled();
    });
  });
});
