import { AssetType, AssetVisibility, JobName, JobStatus, TranscriptionComputeType } from 'src/enum';
import { toTranscriptSegments, TranscriptService } from 'src/services/transcript.service';
import { clearConfigCache } from 'src/utils/config';
import { videoInfoStub } from 'test/fixtures/media.stub';
import { systemConfigStub } from 'test/fixtures/system-config.stub';
import { makeStream, newTestService, ServiceMocks } from 'test/utils';

const enabledConfig = { machineLearning: { videoTranscription: { enabled: true } } };

type TranscriptionAsset = NonNullable<Awaited<ReturnType<ServiceMocks['assetJob']['getForVideoTranscription']>>>;

const makeAsset = (overrides: Partial<TranscriptionAsset> = {}): TranscriptionAsset => ({
  id: 'asset-id',
  type: AssetType.Video,
  visibility: AssetVisibility.Timeline,
  deletedAt: null,
  originalPath: '/original/video.mp4',
  videoStreamAssetId: 'asset-id',
  audioStream: { index: 1, codecName: 'aac', profile: null, bitrate: 128_000 },
  ...overrides,
});

const transcription = {
  // the model the machine learning service picked for the default `auto`
  modelName: 'small',
  language: 'en',
  languageProbability: 0.98,
  duration: 30,
  segments: [
    { start: 0.11, end: 4.49, text: " I'm going to do the best I can because I'm driving." },
    { start: 6.79, end: 14.85, text: ' But I just went to the last full moon party.' },
  ],
};

describe(TranscriptService.name, () => {
  let sut: TranscriptService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TranscriptService));
    mocks.systemMetadata.get.mockResolvedValue(enabledConfig);
    mocks.machineLearning.transcribe.mockResolvedValue(transcription);
    mocks.transcript.replace.mockResolvedValue();
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('toTranscriptSegments', () => {
    it('should store milliseconds, trim the text and drop empty lines', () => {
      expect(
        toTranscriptSegments([
          { start: 0.11, end: 4.494, text: ' Hello there. ' },
          { start: 5, end: 6, text: ' '.repeat(3) },
          { start: 7.5, end: 7.2, text: 'Backwards end' },
          { start: NaN, end: 9, text: 'No start' },
        ]),
      ).toEqual([
        { startTime: 110, endTime: 4494, text: 'Hello there.' },
        { startTime: 7500, endTime: 7500, text: 'Backwards end' },
      ]);
    });
  });

  describe('handleQueueTranscribeVideos', () => {
    it('should do nothing while the feature is off', async () => {
      mocks.systemMetadata.get.mockResolvedValue({});

      await expect(sut.handleQueueTranscribeVideos({ force: false })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.assetJob.streamForVideoTranscription).not.toHaveBeenCalled();
    });

    it('should do nothing if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        ...systemConfigStub.machineLearningDisabled,
        machineLearning: { enabled: false, videoTranscription: { enabled: true } },
      });

      await expect(sut.handleQueueTranscribeVideos({ force: false })).resolves.toBe(JobStatus.Skipped);
    });

    it('should queue the videos without a transcript', async () => {
      mocks.assetJob.streamForVideoTranscription.mockReturnValue(makeStream([{ id: 'video-1' }, { id: 'video-2' }]));

      await expect(sut.handleQueueTranscribeVideos({ force: false })).resolves.toBe(JobStatus.Success);

      expect(mocks.assetJob.streamForVideoTranscription).toHaveBeenCalledWith(false);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetTranscribeVideo, data: { id: 'video-1' } },
        { name: JobName.AssetTranscribeVideo, data: { id: 'video-2' } },
      ]);
    });

    it('should queue every video when forced', async () => {
      mocks.assetJob.streamForVideoTranscription.mockReturnValue(makeStream([{ id: 'video-1' }]));

      await sut.handleQueueTranscribeVideos({ force: true });

      expect(mocks.assetJob.streamForVideoTranscription).toHaveBeenCalledWith(true);
    });
  });

  describe('handleTranscribeVideo', () => {
    it('should do nothing while the feature is off', async () => {
      mocks.systemMetadata.get.mockResolvedValue({});

      await expect(sut.handleTranscribeVideo({ id: 'asset-id' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.assetJob.getForVideoTranscription).not.toHaveBeenCalled();
    });

    it('should fail for an unknown asset', async () => {
      mocks.assetJob.getForVideoTranscription.mockResolvedValue(void 0);

      await expect(sut.handleTranscribeVideo({ id: 'asset-id' })).resolves.toBe(JobStatus.Failed);
    });

    it.each([
      { type: AssetType.Image },
      { visibility: AssetVisibility.Hidden },
      { deletedAt: new Date() },
    ] as Partial<TranscriptionAsset>[])('should skip %o', async (overrides) => {
      mocks.assetJob.getForVideoTranscription.mockResolvedValue(makeAsset(overrides));

      await expect(sut.handleTranscribeVideo({ id: 'asset-id' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.media.extractAudio).not.toHaveBeenCalled();
      expect(mocks.transcript.replace).not.toHaveBeenCalled();
    });

    it('should transcribe the audio stream and store the lines', async () => {
      mocks.assetJob.getForVideoTranscription.mockResolvedValue(makeAsset());

      await expect(sut.handleTranscribeVideo({ id: 'asset-id' })).resolves.toBe(JobStatus.Success);

      expect(mocks.media.extractAudio).toHaveBeenCalledWith('/original/video.mp4', 1);
      expect(mocks.machineLearning.transcribe).toHaveBeenCalledWith(Buffer.from('audio'), {
        modelName: 'auto',
        language: '',
        computeType: TranscriptionComputeType.Auto,
      });
      expect(mocks.transcript.replace).toHaveBeenCalledWith(
        { assetId: 'asset-id', language: 'en', modelName: 'small' },
        [
          { startTime: 110, endTime: 4490, text: "I'm going to do the best I can because I'm driving." },
          { startTime: 6790, endTime: 14_850, text: 'But I just went to the last full moon party.' },
        ],
      );
      expect(mocks.media.probe).not.toHaveBeenCalled();
    });

    it('should pass the configured language and precision', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          videoTranscription: {
            enabled: true,
            modelName: 'small',
            language: 'es',
            computeType: TranscriptionComputeType.Int8,
          },
        },
      });
      mocks.assetJob.getForVideoTranscription.mockResolvedValue(makeAsset());

      await sut.handleTranscribeVideo({ id: 'asset-id' });

      expect(mocks.machineLearning.transcribe).toHaveBeenCalledWith(expect.any(Buffer), {
        modelName: 'small',
        language: 'es',
        computeType: TranscriptionComputeType.Int8,
      });
    });

    it('should store an empty transcript for a video without an audio stream', async () => {
      mocks.assetJob.getForVideoTranscription.mockResolvedValue(makeAsset({ audioStream: null }));

      await expect(sut.handleTranscribeVideo({ id: 'asset-id' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.media.extractAudio).not.toHaveBeenCalled();
      expect(mocks.machineLearning.transcribe).not.toHaveBeenCalled();
      expect(mocks.transcript.replace).toHaveBeenCalledWith(
        { assetId: 'asset-id', language: null, modelName: 'auto' },
        [],
      );
    });

    it('should probe the file of a video imported before stream details were stored', async () => {
      mocks.assetJob.getForVideoTranscription.mockResolvedValue(
        makeAsset({ audioStream: null, videoStreamAssetId: null }),
      );
      mocks.media.probe.mockResolvedValue(videoInfoStub.audioStreamAac);

      await expect(sut.handleTranscribeVideo({ id: 'asset-id' })).resolves.toBe(JobStatus.Success);

      expect(mocks.media.probe).toHaveBeenCalledWith('/original/video.mp4');
      expect(mocks.media.extractAudio).toHaveBeenCalledWith('/original/video.mp4', 1);
    });

    it('should store an empty transcript when the probed file has no audio', async () => {
      mocks.assetJob.getForVideoTranscription.mockResolvedValue(
        makeAsset({ audioStream: null, videoStreamAssetId: null }),
      );
      mocks.media.probe.mockResolvedValue(videoInfoStub.noAudioStreams);

      await expect(sut.handleTranscribeVideo({ id: 'asset-id' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.media.extractAudio).not.toHaveBeenCalled();
      expect(mocks.transcript.replace).toHaveBeenCalledWith(
        { assetId: 'asset-id', language: null, modelName: 'auto' },
        [],
      );
    });

    it('should fail without storing anything when the file cannot be probed', async () => {
      mocks.assetJob.getForVideoTranscription.mockResolvedValue(
        makeAsset({ audioStream: null, videoStreamAssetId: null }),
      );
      mocks.media.probe.mockRejectedValue(new Error('unreadable'));

      await expect(sut.handleTranscribeVideo({ id: 'asset-id' })).resolves.toBe(JobStatus.Failed);

      expect(mocks.transcript.replace).not.toHaveBeenCalled();
    });

    it('should store an empty transcript when the audio cannot be extracted', async () => {
      mocks.assetJob.getForVideoTranscription.mockResolvedValue(makeAsset());
      mocks.media.extractAudio.mockRejectedValue(new Error('broken'));

      await expect(sut.handleTranscribeVideo({ id: 'asset-id' })).resolves.toBe(JobStatus.Failed);

      expect(mocks.machineLearning.transcribe).not.toHaveBeenCalled();
      expect(mocks.transcript.replace).toHaveBeenCalledWith(
        { assetId: 'asset-id', language: null, modelName: 'auto' },
        [],
      );
    });

    it('should let a machine learning error fail the job so it is retried', async () => {
      mocks.assetJob.getForVideoTranscription.mockResolvedValue(makeAsset());
      mocks.machineLearning.transcribe.mockRejectedValue(new Error('ML down'));

      await expect(sut.handleTranscribeVideo({ id: 'asset-id' })).rejects.toThrow('ML down');

      expect(mocks.transcript.replace).not.toHaveBeenCalled();
    });

    it('should store no language for a video without speech', async () => {
      mocks.assetJob.getForVideoTranscription.mockResolvedValue(makeAsset());
      mocks.machineLearning.transcribe.mockResolvedValue({ ...transcription, segments: [] });

      await expect(sut.handleTranscribeVideo({ id: 'asset-id' })).resolves.toBe(JobStatus.Success);

      expect(mocks.transcript.replace).toHaveBeenCalledWith(
        { assetId: 'asset-id', language: null, modelName: 'small' },
        [],
      );
    });

    it('should not store a transcript made by a model that is no longer configured', async () => {
      mocks.assetJob.getForVideoTranscription.mockResolvedValue(makeAsset());
      // the admin picks another model while the video is being transcribed
      mocks.machineLearning.transcribe.mockImplementation(() => {
        mocks.systemMetadata.get.mockResolvedValue({
          machineLearning: { videoTranscription: { enabled: true, modelName: 'small' } },
        });
        clearConfigCache();
        return Promise.resolve(transcription);
      });

      await expect(sut.handleTranscribeVideo({ id: 'asset-id' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.transcript.replace).not.toHaveBeenCalled();
    });
  });
});
