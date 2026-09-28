import { AssetType, JobName, TakeoutRunFileAction, TakeoutRunFileStatus } from 'src/enum';
import { TakeoutRunService } from 'src/services/takeout-run.service';
import { authStub } from 'test/fixtures/auth.stub';
import { newTestService, ServiceMocks } from 'test/utils';
import { beforeEach, describe, expect, it } from 'vitest';

const userId = authStub.admin.user.id;

const run = () => ({
  id: 'run-1',
  userId,
  templateVars: { date: '2020-06-15', user: 'me', start: '2020-06-15' },
});

const settings = () => ({
  homeTimeZone: 'America/New_York',
  syncAlbums: false,
  googlePhotosFields: false,
  applyRotation: false,
  tagServerDuplicates: false,
  sessionTag: false,
  sessionTagTemplate: '',
  takeoutTag: false,
  customTags: [],
});

const uploadRow = (over: Record<string, unknown> = {}) => ({
  id: 'rf-1',
  seq: 0,
  takeoutPath: 'Takeout/Google Photos/photo.jpg',
  originalFileName: 'photo.jpg',
  newAssetId: 'asset-uuid',
  targetPath: '/tmp/does-not-exist/asset-uuid.jpg',
  size: 1234,
  mtime: new Date('2020-06-15T12:00:00Z'),
  checksum: Buffer.from('abcd'),
  captureDate: new Date('2020-06-15T12:00:00Z'),
  rotation: 0,
  fallbacks: [],
  plan: { latitude: 0, longitude: 0, tags: [] },
  ...over,
});

describe(TakeoutRunService.name, () => {
  let sut: TakeoutRunService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TakeoutRunService));
    mocks.asset.getByIds.mockResolvedValue([]);
    mocks.asset.create.mockResolvedValue({
      id: 'asset-uuid',
      originalPath: '/tmp/does-not-exist/asset-uuid.jpg',
    } as any);
    mocks.metadata.writeTags.mockResolvedValue(true as any);
  });

  // Every upsertExif call whose payload actually carries a capture date (the PUT path), ignoring the fileSize upsert.
  const dateUpserts = () =>
    mocks.asset.upsertExif.mock.calls.filter((call) => (call[0] as any)?.exif?.dateTimeOriginal !== undefined);

  const sidecarWriteQueued = () =>
    mocks.job.queue.mock.calls.some((call) => (call[0] as any)?.name === JobName.SidecarWrite);

  const extractionQueuedAfterSidecar = () => {
    const extractCall = mocks.job.queue.mock.calls.findIndex(
      (call) => (call[0] as any)?.name === JobName.AssetExtractMetadata,
    );
    expect(extractCall).toBeGreaterThanOrEqual(0);
    const extractOrder = mocks.job.queue.mock.invocationCallOrder[extractCall];
    for (const order of mocks.metadata.writeTags.mock.invocationCallOrder) {
      expect(order).toBeLessThan(extractOrder);
    }
    for (const order of mocks.asset.upsertExif.mock.invocationCallOrder) {
      expect(order).toBeLessThan(extractOrder);
    }
    for (const order of mocks.asset.unlockProperties.mock.invocationCallOrder) {
      expect(order).toBeLessThan(extractOrder);
    }
  };

  describe('processUpload capture date: PUT dateTimeOriginal vs sidecar (section 12)', () => {
    it('a phone whose zone is derived from Google (rule 3) stores dateTimeOriginal with an explicit offset before extraction', async () => {
      // Google/Pixel phone, wall clock 07:00 vs Google 12:00Z => whole -5h offset, no file offset, no GPS.
      mocks.metadata.readTags.mockResolvedValue({
        Make: 'Google',
        Model: 'Pixel 5',
        DateTimeOriginal: '2020:06:15 07:00:00',
      } as any);

      await (sut as any).processUpload(run(), settings(), uploadRow());

      const puts = dateUpserts();
      expect(puts).toHaveLength(1);
      const exif = (puts[0][0] as any).exif;
      // explicit offset, and the date + zone are locked until the sidecar holds them
      expect(exif.dateTimeOriginal).toMatch(/-05:00$/);
      expect(exif.timeZone).toBe('UTC-5');
      expect(exif.lockedProperties).toEqual(expect.arrayContaining(['dateTimeOriginal', 'timeZone']));
      expect((puts[0][0] as any).lockedPropertiesBehavior).toBe('append');
      // the sidecar gets exactly what SidecarWrite would write, then the locks are released, no SidecarWrite job
      expect(mocks.metadata.writeTags).toHaveBeenCalledTimes(1);
      expect((mocks.metadata.writeTags.mock.calls[0][1] as any).DateTimeOriginal).toBe('2020-06-15T07:00:00.000-05:00');
      expect(mocks.asset.unlockProperties).toHaveBeenCalledWith('asset-uuid', ['dateTimeOriginal', 'timeZone']);
      expect(sidecarWriteQueued()).toBe(false);
      extractionQueuedAfterSidecar();
    });

    it('a phone that carries its own offset (rule 1) does NOT store a date and writes nothing to the sidecar', async () => {
      mocks.metadata.readTags.mockResolvedValue({
        Make: 'Apple',
        Model: 'iPhone 12',
        DateTimeOriginal: '2020:06:15 07:00:00',
        zone: 'UTC-5',
        zoneSource: 'offset',
        GPSLatitude: 40,
        GPSLongitude: -73,
      } as any);

      await (sut as any).processUpload(run(), settings(), uploadRow());

      expect(dateUpserts()).toHaveLength(0);
      expect(sidecarWriteQueued()).toBe(false);
      expect(mocks.metadata.writeTags).not.toHaveBeenCalled();
    });

    it('tags a new asset through the sidecar TagsList before extraction, without the AssetTag event', async () => {
      mocks.metadata.readTags.mockResolvedValue({
        Make: 'Apple',
        Model: 'iPhone 12',
        DateTimeOriginal: '2020:06:15 07:00:00',
        zone: 'UTC-5',
        zoneSource: 'offset',
      } as any);
      mocks.tag.upsertValue.mockImplementation(
        ({ value }: any) => Promise.resolve({ id: `tag-${value}`, value }) as any,
      );
      mocks.tag.upsertAssetIds.mockResolvedValue([] as any);

      await (sut as any).processUpload(
        run(),
        settings(),
        uploadRow({ plan: { latitude: 0, longitude: 0, tags: ['People/Ana Lozano ', 'takeout-x'] } }),
      );

      const tags = mocks.metadata.writeTags.mock.calls[0][1] as any;
      // the trailing space of a Google person name is kept, as Go sends it
      expect(tags.TagsList).toEqual(['People/Ana Lozano ', 'takeout-x']);
      expect(tags.DateTimeOriginal).toBeUndefined();
      expect(mocks.asset.unlockProperties).toHaveBeenCalledWith('asset-uuid', ['tags']);
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AssetTag', expect.anything());
      extractionQueuedAfterSidecar();
    });

    it('writes Google GPS to the sidecar when the file lacks GPS', async () => {
      mocks.metadata.readTags.mockResolvedValue({
        Make: 'Google',
        Model: 'Pixel 5',
        DateTimeOriginal: '2020:06:15 07:00:00',
      } as any);

      await (sut as any).processUpload(
        run(),
        settings(),
        uploadRow({ plan: { latitude: 40.1, longitude: -73.2, tags: [] } }),
      );

      expect(mocks.metadata.writeTags).toHaveBeenCalledTimes(1);
      const tags = mocks.metadata.writeTags.mock.calls[0][1] as any;
      expect(tags.GPSLatitude).toBe(40.1);
      expect(tags.GPSLongitude).toBe(-73.2);
      expect(dateUpserts()).toHaveLength(1);
      extractionQueuedAfterSidecar();
    });

    it('does not write Google GPS to the sidecar when the file already has GPS', async () => {
      mocks.metadata.readTags.mockResolvedValue({
        Make: 'Google',
        Model: 'Pixel 5',
        DateTimeOriginal: '2020:06:15 07:00:00',
        GPSLatitude: 1,
        GPSLongitude: 2,
      } as any);

      await (sut as any).processUpload(
        run(),
        settings(),
        uploadRow({ plan: { latitude: 40.1, longitude: -73.2, tags: [] } }),
      );

      const tags = mocks.metadata.writeTags.mock.calls[0]?.[1] as any;
      expect(tags?.GPSLatitude).toBeUndefined();
      expect(tags?.GPSLongitude).toBeUndefined();
    });
  });

  describe('phaseRotateFaces: section 11 D1 rotate-only face reconciliation', () => {
    it('rotates the original, re-detects faces, reconciles the copy people, then drops the copy in that order', async () => {
      const original = {
        id: 'rf-orig',
        seq: 0,
        assetId: 'asset-orig',
        status: TakeoutRunFileStatus.Created,
        action: TakeoutRunFileAction.Upload,
        rotation: 90,
        plan: { rotateOriginal: true, rotateAngle: 90, rotateCopySeqs: [1], tags: ['People/Alice'] },
      };
      const copy = {
        id: 'rf-copy',
        seq: 1,
        assetId: null,
        status: TakeoutRunFileStatus.Skipped,
        action: TakeoutRunFileAction.RotateOnlyDropped,
        plan: { rotateCopyOf: 0, tags: ['People/Bob'] },
      };

      mocks.asset.getById.mockResolvedValue({
        type: 'IMAGE',
        originalPath: '/x/asset-orig.jpg',
        exifInfo: { exifImageWidth: 100, exifImageHeight: 200 },
        edits: [],
      } as any);
      mocks.job.run.mockResolvedValue(undefined as any);
      mocks.assetEdit.replaceAll.mockResolvedValue(undefined as any);
      mocks.tag.upsertValue.mockImplementation(
        ({ value }: any) => Promise.resolve({ id: `tag-${value}`, value }) as any,
      );

      await (sut as any).phaseRotateFaces(run(), settings(), [original, copy]);

      // rotation edit applied to the original
      expect(mocks.assetEdit.replaceAll).toHaveBeenCalledWith('asset-orig', expect.any(Array));
      // face detection queued + awaited on the original
      expect(mocks.job.run).toHaveBeenCalledWith({
        name: JobName.AssetDetectFaces,
        data: { id: 'asset-orig', source: 'upload' },
      });
      // the copy's named people reconciled onto the original
      expect(mocks.tag.upsertAssetIds).toHaveBeenCalled();
      const assignedTagIds = mocks.tag.upsertAssetIds.mock.calls[0][0].map((t: any) => t.tagId);
      expect(assignedTagIds).toEqual(expect.arrayContaining(['tag-People/Alice', 'tag-People/Bob']));
      // the copy is dropped last: its Done transition happens after the rotation edit and face detection
      const dropCall = mocks.takeout.updateRunFile.mock.calls.find(
        (c) => c[0] === 'rf-copy' && (c[1] as any)?.status === TakeoutRunFileStatus.Done,
      );
      expect(dropCall).toBeTruthy();
      const dropOrder = mocks.takeout.updateRunFile.mock.invocationCallOrder.at(-1)!;
      expect(mocks.assetEdit.replaceAll.mock.invocationCallOrder[0]).toBeLessThan(dropOrder);
      expect(mocks.job.run.mock.invocationCallOrder.at(-1)!).toBeLessThan(dropOrder);
    });

    it('never drops the copy when the original was not created', async () => {
      const original = {
        id: 'rf-orig',
        seq: 0,
        assetId: null,
        status: TakeoutRunFileStatus.Planned,
        action: TakeoutRunFileAction.Upload,
        rotation: 90,
        plan: { rotateOriginal: true, rotateAngle: 90, rotateCopySeqs: [1], tags: [] },
      };
      const copy = { id: 'rf-copy', seq: 1, status: TakeoutRunFileStatus.Skipped, plan: { rotateCopyOf: 0, tags: [] } };

      await (sut as any).phaseRotateFaces(run(), settings(), [original, copy]);

      expect(mocks.job.run).not.toHaveBeenCalled();
      expect(mocks.assetEdit.replaceAll).not.toHaveBeenCalled();
      expect(mocks.takeout.updateRunFile).not.toHaveBeenCalled();
    });
  });

  describe('verifyAndRequeue: finding T9/#9 post-import verification', () => {
    it('re-queues only the jobs that did not run for each created asset', async () => {
      const rows = [
        { assetId: 'a-img', action: TakeoutRunFileAction.Upload, status: TakeoutRunFileStatus.Done },
        { assetId: 'a-vid', action: TakeoutRunFileAction.Upload, status: TakeoutRunFileStatus.Created },
        { assetId: 'a-dupe', action: TakeoutRunFileAction.ServerDuplicate, status: TakeoutRunFileStatus.Done },
      ];
      mocks.takeout.getPostImportState.mockResolvedValue([
        // image is fully done -> nothing re-queued
        {
          id: 'a-img',
          type: AssetType.Image,
          hasThumbhash: true,
          metadataDone: true,
          hasPreview: true,
          hasThumbnail: true,
          hasEncodedVideo: false,
        },
        // video is missing metadata, thumbnail and its encoded video -> all three re-queued
        {
          id: 'a-vid',
          type: AssetType.Video,
          hasThumbhash: false,
          metadataDone: false,
          hasPreview: false,
          hasThumbnail: false,
          hasEncodedVideo: false,
        },
      ] as any);

      await (sut as any).verifyAndRequeue(rows);

      // only the two uploaded assets are checked (server duplicate excluded)
      expect(mocks.takeout.getPostImportState).toHaveBeenCalledWith(['a-img', 'a-vid']);
      const queued = mocks.job.queueAll.mock.calls[0][0].map((j: any) => j.name);
      expect(queued).toEqual(
        expect.arrayContaining([
          JobName.AssetExtractMetadata,
          JobName.AssetGenerateThumbnails,
          JobName.AssetEncodeVideo,
        ]),
      );
      // the fully-done image contributed no jobs
      expect(queued.filter((n: string) => n === JobName.AssetGenerateThumbnails)).toHaveLength(1);
    });

    it('queues nothing when there are no created upload assets', async () => {
      await (sut as any).verifyAndRequeue([
        { assetId: 'x', action: TakeoutRunFileAction.ServerDuplicate, status: TakeoutRunFileStatus.Done },
      ]);
      expect(mocks.takeout.getPostImportState).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });
  });
});
