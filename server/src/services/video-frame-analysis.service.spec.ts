import { AssetType, AssetVisibility, JobName, JobStatus } from 'src/enum';
import { VideoFrameAnalysisService } from 'src/services/video-frame-analysis.service';
import { videoInfoStub } from 'test/fixtures/media.stub';
import { systemConfigStub } from 'test/fixtures/system-config.stub';
import { makeStream, newTestService, ServiceMocks } from 'test/utils';

const enabledConfig = { machineLearning: { videoFrameAnalysis: { enabled: true } } };

const videoStream = { ...videoInfoStub.videoStreamH264.videoStreams[0], timeBase: 600 };

type AnalysisAsset = NonNullable<Awaited<ReturnType<ServiceMocks['assetJob']['getForVideoFrameAnalysis']>>>;

const makeAsset = (overrides: Partial<AnalysisAsset> = {}): AnalysisAsset => ({
  id: 'asset-id',
  type: AssetType.Video,
  visibility: AssetVisibility.Timeline,
  deletedAt: null,
  originalPath: '/original/video.mp4',
  duration: 10_000,
  thumbnailEmbedding: null,
  videoStream,
  faces: [],
  ...overrides,
});

const detectedFace = (embedding: number[], overrides: Record<string, unknown> = {}) => ({
  boundingBox: { x1: 100, y1: 100, x2: 300, y2: 300 },
  embedding: JSON.stringify(embedding),
  score: 0.95,
  ...overrides,
});

describe(VideoFrameAnalysisService.name, () => {
  let sut: VideoFrameAnalysisService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(VideoFrameAnalysisService));
    mocks.systemMetadata.get.mockResolvedValue(enabledConfig);
    mocks.search.getMinFaceDistance.mockResolvedValue(null);
    mocks.person.refreshFaces.mockResolvedValue();
    let id = 0;
    mocks.crypto.randomUUID.mockImplementation(() => `face-${++id}`);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('handleQueueAnalyzeVideoFrames', () => {
    it('should do nothing while the feature is off', async () => {
      mocks.systemMetadata.get.mockResolvedValue({});

      await expect(sut.handleQueueAnalyzeVideoFrames({ force: false })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.assetJob.streamForVideoFrameAnalysis).not.toHaveBeenCalled();
    });

    it('should do nothing if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        ...systemConfigStub.machineLearningDisabled,
        machineLearning: { enabled: false, videoFrameAnalysis: { enabled: true } },
      });

      await expect(sut.handleQueueAnalyzeVideoFrames({ force: false })).resolves.toBe(JobStatus.Skipped);
    });

    it('should queue the videos that were not analyzed', async () => {
      mocks.assetJob.streamForVideoFrameAnalysis.mockReturnValue(makeStream([{ id: 'video-1' }, { id: 'video-2' }]));

      await expect(sut.handleQueueAnalyzeVideoFrames({ force: false })).resolves.toBe(JobStatus.Success);

      expect(mocks.assetJob.streamForVideoFrameAnalysis).toHaveBeenCalledWith(false);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetAnalyzeVideoFrames, data: { id: 'video-1' } },
        { name: JobName.AssetAnalyzeVideoFrames, data: { id: 'video-2' } },
      ]);
    });
  });

  describe('handleAnalyzeVideoFrames', () => {
    it('should skip while the feature is off', async () => {
      mocks.systemMetadata.get.mockResolvedValue({});

      await expect(sut.handleAnalyzeVideoFrames({ id: 'asset-id' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.assetJob.getForVideoFrameAnalysis).not.toHaveBeenCalled();
    });

    it.each([
      { name: 'images', asset: makeAsset({ type: AssetType.Image }) },
      { name: 'hidden motion photo videos', asset: makeAsset({ visibility: AssetVisibility.Hidden }) },
      { name: 'trashed videos', asset: makeAsset({ deletedAt: new Date() }) },
    ])('should skip $name', async ({ asset }) => {
      mocks.assetJob.getForVideoFrameAnalysis.mockResolvedValue(asset);

      await expect(sut.handleAnalyzeVideoFrames({ id: asset.id })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.media.extractVideoFrame).not.toHaveBeenCalled();
    });

    it('should read the stream details from the file when the database has none', async () => {
      mocks.assetJob.getForVideoFrameAnalysis.mockResolvedValue(makeAsset({ videoStream: null, duration: null }));
      mocks.media.probe.mockResolvedValue({
        ...videoInfoStub.videoStreamH264,
        format: { ...videoInfoStub.videoStreamH264.format, duration: 3.5 },
      });
      mocks.machineLearning.analyzeImage.mockResolvedValue({ imageWidth: 1, imageHeight: 1, clip: '[1]', faces: [] });

      await expect(sut.handleAnalyzeVideoFrames({ id: 'asset-id' })).resolves.toBe(JobStatus.Success);

      expect(mocks.media.probe).toHaveBeenCalledWith('/original/video.mp4');
      expect(mocks.media.extractVideoFrame).toHaveBeenCalledTimes(1);
      expect(mocks.media.extractVideoFrame).toHaveBeenCalledWith(
        '/original/video.mp4',
        expect.objectContaining({ inputOptions: expect.arrayContaining(['-ss', '1.750']) }),
      );
    });

    it('should mark a video whose stream details cannot be read as analyzed', async () => {
      mocks.assetJob.getForVideoFrameAnalysis.mockResolvedValue(makeAsset({ videoStream: null }));
      mocks.media.probe.mockRejectedValue(new Error('invalid data'));

      await expect(sut.handleAnalyzeVideoFrames({ id: 'asset-id' })).resolves.toBe(JobStatus.Failed);

      expect(mocks.media.extractVideoFrame).not.toHaveBeenCalled();
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith({
        assetId: 'asset-id',
        videoFramesAnalyzedAt: expect.any(Date),
      });
    });

    it('should mark a video with an unknown duration as analyzed', async () => {
      mocks.assetJob.getForVideoFrameAnalysis.mockResolvedValue(makeAsset({ duration: null }));

      await expect(sut.handleAnalyzeVideoFrames({ id: 'asset-id' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.media.extractVideoFrame).not.toHaveBeenCalled();
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith({
        assetId: 'asset-id',
        videoFramesAnalyzedAt: expect.any(Date),
      });
    });

    it('should store one embedding per distinct frame without touching the thumbnail embedding', async () => {
      mocks.assetJob.getForVideoFrameAnalysis.mockResolvedValue(makeAsset({ thumbnailEmbedding: '[0, 0, 1]' }));
      mocks.machineLearning.analyzeImage
        .mockResolvedValueOnce({ imageWidth: 1920, imageHeight: 1080, clip: '[1, 0, 0]', faces: [] })
        .mockResolvedValueOnce({ imageWidth: 1920, imageHeight: 1080, clip: '[1, 0.001, 0]', faces: [] })
        .mockResolvedValueOnce({ imageWidth: 1920, imageHeight: 1080, clip: '[0, 1, 0]', faces: [] })
        .mockResolvedValueOnce({ imageWidth: 1920, imageHeight: 1080, clip: '[0, 0, 1]', faces: [] });

      await expect(sut.handleAnalyzeVideoFrames({ id: 'asset-id' })).resolves.toBe(JobStatus.Success);

      expect(mocks.media.extractVideoFrame).toHaveBeenCalledTimes(4);
      expect(mocks.media.extractVideoFrame).toHaveBeenCalledWith(
        '/original/video.mp4',
        expect.objectContaining({ inputOptions: expect.arrayContaining(['-ss', '1.250']) }),
      );
      expect(mocks.machineLearning.analyzeImage).toHaveBeenCalledWith(Buffer.from('frame'), {
        clip: expect.objectContaining({ modelName: 'ViT-B-32__openai' }),
        facialRecognition: expect.objectContaining({ modelName: 'buffalo_l' }),
      });
      expect(mocks.search.replaceFrames).toHaveBeenCalledWith('asset-id', [
        { frameTimestamp: 1250, embedding: '[1, 0, 0]' },
        { frameTimestamp: 6250, embedding: '[0, 1, 0]' },
      ]);
      expect(mocks.search.upsert).not.toHaveBeenCalled();
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith({
        assetId: 'asset-id',
        videoFramesAnalyzedAt: expect.any(Date),
      });
    });

    it('should only detect faces when smart search is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { clip: { enabled: false }, videoFrameAnalysis: { enabled: true } },
      });
      mocks.assetJob.getForVideoFrameAnalysis.mockResolvedValue(makeAsset({ duration: 1000 }));
      mocks.machineLearning.analyzeImage.mockResolvedValue({ imageWidth: 1920, imageHeight: 1080, faces: [] });

      await expect(sut.handleAnalyzeVideoFrames({ id: 'asset-id' })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearning.analyzeImage).toHaveBeenCalledWith(expect.any(Buffer), {
        clip: undefined,
        facialRecognition: expect.objectContaining({ modelName: 'buffalo_l' }),
      });
      expect(mocks.search.replaceFrames).not.toHaveBeenCalled();
    });

    it('should skip frames that cannot be extracted', async () => {
      mocks.assetJob.getForVideoFrameAnalysis.mockResolvedValue(makeAsset());
      mocks.media.extractVideoFrame.mockRejectedValueOnce(new Error('corrupt')).mockResolvedValue(Buffer.from('ok'));
      mocks.machineLearning.analyzeImage.mockResolvedValue({ imageWidth: 1, imageHeight: 1, clip: '[1]', faces: [] });

      await expect(sut.handleAnalyzeVideoFrames({ id: 'asset-id' })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearning.analyzeImage).toHaveBeenCalledTimes(3);
    });

    it('should mark a video where no frame can be extracted as analyzed and failed', async () => {
      mocks.assetJob.getForVideoFrameAnalysis.mockResolvedValue(makeAsset());
      mocks.media.extractVideoFrame.mockRejectedValue(new Error('corrupt'));

      await expect(sut.handleAnalyzeVideoFrames({ id: 'asset-id' })).resolves.toBe(JobStatus.Failed);

      expect(mocks.machineLearning.analyzeImage).not.toHaveBeenCalled();
      expect(mocks.search.replaceFrames).not.toHaveBeenCalled();
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith({
        assetId: 'asset-id',
        videoFramesAnalyzedAt: expect.any(Date),
      });
    });

    it('should fail without marking the video when machine learning is unavailable', async () => {
      mocks.assetJob.getForVideoFrameAnalysis.mockResolvedValue(makeAsset());
      mocks.machineLearning.analyzeImage.mockRejectedValue(new Error('Machine learning request failed for all URLs'));

      await expect(sut.handleAnalyzeVideoFrames({ id: 'asset-id' })).rejects.toThrow();

      expect(mocks.asset.upsertJobStatus).not.toHaveBeenCalled();
    });

    describe('faces', () => {
      it('should add one face per person seen in the video and queue recognition', async () => {
        mocks.assetJob.getForVideoFrameAnalysis.mockResolvedValue(makeAsset());
        mocks.machineLearning.analyzeImage
          .mockResolvedValueOnce({ imageWidth: 1920, imageHeight: 1080, faces: [detectedFace([1, 0], { score: 0.8 })] })
          .mockResolvedValueOnce({ imageWidth: 1920, imageHeight: 1080, faces: [detectedFace([0.99, 0.05])] })
          .mockResolvedValueOnce({ imageWidth: 1920, imageHeight: 1080, faces: [] })
          .mockResolvedValueOnce({ imageWidth: 1920, imageHeight: 1080, faces: [] });

        await expect(sut.handleAnalyzeVideoFrames({ id: 'asset-id' })).resolves.toBe(JobStatus.Success);

        expect(mocks.person.refreshFaces).toHaveBeenCalledWith(
          [
            {
              id: 'face-1',
              assetId: 'asset-id',
              imageWidth: 1920,
              imageHeight: 1080,
              boundingBoxX1: 100,
              boundingBoxY1: 100,
              boundingBoxX2: 300,
              boundingBoxY2: 300,
              frameTimestamp: 3750,
            },
          ],
          [],
          [{ faceId: 'face-1', embedding: '[0.99,0.05]' }],
        );
        expect(mocks.job.queueAll).toHaveBeenCalledWith([
          { name: JobName.FacialRecognitionQueueAll, data: { force: false } },
          { name: JobName.FacialRecognition, data: { id: 'face-1' } },
        ]);
      });

      it('should ignore small faces, low scores and unclear faces seen in only one frame', async () => {
        mocks.assetJob.getForVideoFrameAnalysis.mockResolvedValue(makeAsset());
        mocks.machineLearning.analyzeImage
          .mockResolvedValueOnce({
            imageWidth: 1920,
            imageHeight: 1080,
            faces: [
              detectedFace([1, 0], { boundingBox: { x1: 0, y1: 0, x2: 20, y2: 20 } }),
              detectedFace([0, 1], { score: 0.5 }),
              detectedFace([1, 1], { score: 0.75 }),
            ],
          })
          .mockResolvedValue({ imageWidth: 1920, imageHeight: 1080, faces: [] });

        await expect(sut.handleAnalyzeVideoFrames({ id: 'asset-id' })).resolves.toBe(JobStatus.Success);

        expect(mocks.person.refreshFaces).not.toHaveBeenCalled();
        expect(mocks.job.queueAll).not.toHaveBeenCalled();
      });

      it('should skip people whose face is already on the video', async () => {
        mocks.assetJob.getForVideoFrameAnalysis.mockResolvedValue(
          makeAsset({ faces: [{ id: 'thumbnail-face', personGroupId: null, embedding: '[1, 0]' }] }),
        );
        mocks.machineLearning.analyzeImage.mockResolvedValue({
          imageWidth: 1920,
          imageHeight: 1080,
          faces: [detectedFace([1, 0.01])],
        });

        await expect(sut.handleAnalyzeVideoFrames({ id: 'asset-id' })).resolves.toBe(JobStatus.Success);

        expect(mocks.person.refreshFaces).not.toHaveBeenCalled();
      });

      it('should skip people tagged on the video without a face embedding', async () => {
        mocks.assetJob.getForVideoFrameAnalysis.mockResolvedValue(
          makeAsset({ faces: [{ id: 'manual-face', personGroupId: 'person-1', embedding: null }] }),
        );
        mocks.machineLearning.analyzeImage.mockResolvedValue({
          imageWidth: 1920,
          imageHeight: 1080,
          faces: [detectedFace([1, 0])],
        });
        mocks.search.getMinFaceDistance.mockResolvedValue(0.2);

        await expect(sut.handleAnalyzeVideoFrames({ id: 'asset-id' })).resolves.toBe(JobStatus.Success);

        expect(mocks.search.getMinFaceDistance).toHaveBeenCalledWith('[1,0]', ['person-1']);
        expect(mocks.person.refreshFaces).not.toHaveBeenCalled();
      });

      it('should not detect faces when disabled for video frames', async () => {
        mocks.systemMetadata.get.mockResolvedValue({
          machineLearning: { videoFrameAnalysis: { enabled: true, detectFaces: false } },
        });
        mocks.assetJob.getForVideoFrameAnalysis.mockResolvedValue(makeAsset({ duration: 1000 }));
        mocks.machineLearning.analyzeImage.mockResolvedValue({ imageWidth: 1, imageHeight: 1, clip: '[1]' });

        await expect(sut.handleAnalyzeVideoFrames({ id: 'asset-id' })).resolves.toBe(JobStatus.Success);

        expect(mocks.machineLearning.analyzeImage).toHaveBeenCalledWith(expect.any(Buffer), {
          clip: expect.anything(),
          facialRecognition: undefined,
        });
        expect(mocks.person.refreshFaces).not.toHaveBeenCalled();
      });
    });
  });
});
