import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  AssetType,
  JobName,
  JobStatus,
  PersonSuggestionKind,
  PersonSuggestionSource,
  PersonSuggestionStatus,
} from 'src/enum';
import { PersonSuggestionService } from 'src/services/person-suggestion.service';
import { AuthFactory } from 'test/factories/auth.factory';
import { videoInfoStub } from 'test/fixtures/media.stub';
import { systemConfigStub } from 'test/fixtures/system-config.stub';
import { newDate, newUuid } from 'test/small.factory';
import { newTestService, ServiceMocks } from 'test/utils';

const newSuggestion = (dto: Record<string, unknown> = {}) => ({
  id: newUuid(),
  ownerId: newUuid(),
  kind: PersonSuggestionKind.Named,
  source: PersonSuggestionSource.Automatic,
  personGroupId: newUuid() as string | null,
  faceId: null as string | null,
  targetPersonGroupId: newUuid(),
  score: 0.42,
  priority: 1.5,
  status: PersonSuggestionStatus.Pending,
  undo: null,
  answeredAt: null,
  createdAt: newDate(),
  updatedAt: newDate(),
  updateId: newUuid(),
  ...dto,
});

describe(PersonSuggestionService.name, () => {
  let sut: PersonSuggestionService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PersonSuggestionService));
    mocks.personSuggestion.getShownFaces.mockResolvedValue([]);
    mocks.personSuggestion.getShownFacesByIds.mockResolvedValue([]);
    mocks.personSuggestion.getMostSimilarFaces.mockResolvedValue([]);
    mocks.personSuggestion.getShownAssetCount.mockResolvedValue(0);
    mocks.person.getByGroupId.mockResolvedValue(undefined);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('handleQueueSuggestions', () => {
    it('should queue a job for every user', async () => {
      const users = [{ id: newUuid() }, { id: newUuid() }];
      mocks.user.getList.mockResolvedValue(users as any);

      await expect(sut.handleQueueSuggestions({ force: true })).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queueAll).toHaveBeenCalledWith(
        users.map(({ id }) => ({ name: JobName.PersonSuggestions, data: { userId: id } })),
      );
    });

    it('should work them out at most once an hour unless forced', async () => {
      mocks.user.getList.mockResolvedValue([{ id: newUuid() }] as any);

      await expect(sut.handleQueueSuggestions({ force: true })).resolves.toBe(JobStatus.Success);
      await expect(sut.handleQueueSuggestions({})).resolves.toBe(JobStatus.Skipped);
      await expect(sut.handleQueueSuggestions({ force: true })).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queueAll).toHaveBeenCalledTimes(2);
    });

    it('should skip when machine learning is off', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      await expect(sut.handleQueueSuggestions()).resolves.toBe(JobStatus.Skipped);

      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should skip when person suggestions are off', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { personSuggestions: { enabled: false } },
      });

      await expect(sut.handleQueueSuggestions()).resolves.toBe(JobStatus.Skipped);
    });
  });

  describe('handleSuggestions', () => {
    it('should drop open questions of a user without faces', async () => {
      const userId = newUuid();
      const pending = newSuggestion({ ownerId: userId });
      const answered = newSuggestion({ ownerId: userId, status: PersonSuggestionStatus.Different });
      mocks.personSuggestion.getAll.mockResolvedValue([pending, answered] as any);
      mocks.personSuggestion.getTypicalFaceNorm.mockResolvedValue(null);
      mocks.personSuggestion.getCandidateStatistics.mockResolvedValue([]);
      mocks.personSuggestion.reopenSkipped.mockResolvedValue();
      mocks.personSuggestion.deleteAll.mockResolvedValue();
      mocks.personSuggestion.updateScores.mockResolvedValue();
      mocks.personSuggestion.createAll.mockResolvedValue();

      await expect(sut.handleSuggestions({ userId })).resolves.toBe(JobStatus.Success);

      expect(mocks.personSuggestion.reopenSkipped).toHaveBeenCalledWith(userId, expect.any(Date));
      expect(mocks.personSuggestion.deleteAll).toHaveBeenCalledWith([pending.id]);
      expect(mocks.personSuggestion.createAll).toHaveBeenCalledWith([]);
    });
  });

  describe('refresh', () => {
    it("should queue the user's suggestions", async () => {
      const auth = AuthFactory.create();

      await sut.refresh(auth);

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.PersonSuggestions, data: { userId: auth.user.id } });
    });
  });

  describe('answer', () => {
    it("should not answer another user's question", async () => {
      const auth = AuthFactory.create();
      mocks.personSuggestion.get.mockResolvedValue(newSuggestion() as any);

      await expect(sut.answer(auth, newUuid(), { answer: PersonSuggestionStatus.Different })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.personSuggestion.update).not.toHaveBeenCalled();
    });

    it('should keep a different answer', async () => {
      const auth = AuthFactory.create();
      const suggestion = newSuggestion({ ownerId: auth.user.id });
      mocks.personSuggestion.get.mockResolvedValue(suggestion as any);
      mocks.personSuggestion.update.mockResolvedValue({
        ...suggestion,
        status: PersonSuggestionStatus.Different,
      } as any);

      await expect(sut.answer(auth, suggestion.id, { answer: PersonSuggestionStatus.Different })).resolves.toEqual(
        expect.objectContaining({ id: suggestion.id, status: PersonSuggestionStatus.Different }),
      );

      expect(mocks.personSuggestion.update).toHaveBeenCalledWith(suggestion.id, {
        status: PersonSuggestionStatus.Different,
        answeredAt: expect.any(Date),
        undo: null,
      });
      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
    });
  });

  describe('undoAnswer', () => {
    it('should ask a skipped question again', async () => {
      const auth = AuthFactory.create();
      const suggestion = newSuggestion({ ownerId: auth.user.id, status: PersonSuggestionStatus.Skipped });
      mocks.personSuggestion.get.mockResolvedValue(suggestion as any);
      mocks.personSuggestion.update.mockResolvedValue({ ...suggestion, status: PersonSuggestionStatus.Pending } as any);

      await sut.undoAnswer(auth, suggestion.id);

      expect(mocks.personSuggestion.update).toHaveBeenCalledWith(suggestion.id, {
        status: PersonSuggestionStatus.Pending,
        answeredAt: null,
        undo: null,
      });
    });

    it('should refuse a question without an answer', async () => {
      const auth = AuthFactory.create();
      mocks.personSuggestion.get.mockResolvedValue(newSuggestion({ ownerId: auth.user.id }) as any);

      await expect(sut.undoAnswer(auth, newUuid())).rejects.toThrow('This question has no answer to take back');
    });

    it('should refuse to take back a merge whose faces moved on', async () => {
      const auth = AuthFactory.create();
      const suggestion = newSuggestion({
        ownerId: auth.user.id,
        personGroupId: null,
        status: PersonSuggestionStatus.Same,
        undo: { personGroupId: newUuid(), faceIds: [newUuid()] },
      });
      mocks.personSuggestion.get.mockResolvedValue(suggestion as any);
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([suggestion.targetPersonGroupId]));
      mocks.person.getByGroupId.mockResolvedValue({ name: 'Ann' } as any);
      mocks.personSuggestion.getFacesStillWith.mockResolvedValue([]);

      await expect(sut.undoAnswer(auth, suggestion.id)).rejects.toThrow(
        'The faces were moved since, there is nothing to take back',
      );
      expect(mocks.personSuggestion.moveFaces).not.toHaveBeenCalled();
    });
  });

  describe('getFaceThumbnail', () => {
    const face = {
      id: newUuid(),
      x1: 10,
      y1: 10,
      x2: 30,
      y2: 30,
      oldWidth: 100,
      oldHeight: 100,
      frameTimestamp: null as number | null,
      isWholeAsset: false,
      assetId: newUuid(),
      ownerId: '',
      type: AssetType.Image,
      originalPath: '/original.jpg',
      isPrivate: false,
      exifOrientation: null,
      previewPath: '/preview.jpg' as string | null,
      videoStream: null as any,
    };

    it("should not show someone else's face", async () => {
      mocks.personSuggestion.getFaceForCrop.mockResolvedValue({ ...face, ownerId: newUuid() });

      await expect(sut.getFaceThumbnail(AuthFactory.create(), face.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should not cut a whole-asset mark', async () => {
      const auth = AuthFactory.create();
      mocks.personSuggestion.getFaceForCrop.mockResolvedValue({ ...face, ownerId: auth.user.id, isWholeAsset: true });

      await expect(sut.getFaceThumbnail(auth, face.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should cut a face found in a video frame from that frame', async () => {
      const auth = AuthFactory.create();
      const videoStream = { ...videoInfoStub.videoStreamH264.videoStreams[0], timeBase: 600 };
      mocks.personSuggestion.getFaceForCrop.mockResolvedValue({
        ...face,
        ownerId: auth.user.id,
        type: AssetType.Video,
        frameTimestamp: 5000,
        videoStream,
      });
      mocks.personSuggestion.isAssetInScope.mockResolvedValue(true);
      mocks.media.decodeImage.mockResolvedValue({ data: Buffer.from('raw'), info: { width: 200, height: 200 } as any });

      await expect(sut.getFaceThumbnail(auth, face.id)).resolves.toEqual({
        data: Buffer.from('thumbnail'),
        isPrivate: false,
      });

      expect(mocks.media.extractVideoFrame).toHaveBeenCalledWith('/original.jpg', expect.anything());
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(Buffer.from('frame'), expect.anything());
    });
  });
});
