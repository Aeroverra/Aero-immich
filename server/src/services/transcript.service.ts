import { Injectable } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { AssetType, AssetVisibility, JobName, JobStatus, QueueName } from 'src/enum';
import { TranscriptionSegment } from 'src/repositories/machine-learning.repository';
import { TranscriptSegment } from 'src/repositories/transcript.repository';
import { BaseService } from 'src/services/base.service';
import { JobOf } from 'src/types';
import { batched, isVideoTranscriptionEnabled } from 'src/utils/misc';

/** Turns the lines of a speech to text result into stored segments: milliseconds, no empty lines, never backwards */
export const toTranscriptSegments = (segments: TranscriptionSegment[]): TranscriptSegment[] =>
  segments.flatMap(({ start, end, text }) => {
    const trimmed = text.trim();
    if (!trimmed || !Number.isFinite(start)) {
      return [];
    }

    const startTime = Math.max(0, Math.round(start * 1000));
    const endTime = Math.max(startTime, Math.round((Number.isFinite(end) ? end : start) * 1000));
    return [{ startTime, endTime, text: trimmed }];
  });

@Injectable()
export class TranscriptService extends BaseService {
  @OnJob({ name: JobName.AssetTranscribeVideoQueueAll, queue: QueueName.VideoTranscription })
  async handleQueueTranscribeVideos({ force }: JobOf<JobName.AssetTranscribeVideoQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isVideoTranscriptionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    for await (const assets of batched(this.assetJobRepository.streamForVideoTranscription(force))) {
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.AssetTranscribeVideo, data: { id: asset.id } })),
      );
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetTranscribeVideo, queue: QueueName.VideoTranscription })
  async handleTranscribeVideo({ id }: JobOf<JobName.AssetTranscribeVideo>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isVideoTranscriptionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForVideoTranscription(id);
    if (!asset) {
      return JobStatus.Failed;
    }

    if (asset.type !== AssetType.Video || asset.visibility === AssetVisibility.Hidden || asset.deletedAt) {
      return JobStatus.Skipped;
    }

    const { modelName, language, computeType } = machineLearning.videoTranscription;

    let audioStreamIndex = asset.audioStream?.index;
    if (audioStreamIndex === undefined && !asset.videoStreamAssetId) {
      // videos imported before stream details were stored in the database only have them in the file
      try {
        const probed = await this.mediaRepository.probe(asset.originalPath);
        audioStreamIndex = probed.audioStreams[0]?.index;
      } catch (error) {
        this.logger.warn(`Could not probe asset ${id} for video transcription: ${error}`);
        return JobStatus.Failed;
      }
    }

    if (audioStreamIndex === undefined) {
      // nothing can be said in a video without sound, an empty transcript keeps it out of the next "missing" run
      this.logger.debug(`Video ${id} has no audio stream, nothing to transcribe`);
      await this.transcriptRepository.replace({ assetId: id, language: null, modelName }, []);
      return JobStatus.Skipped;
    }

    let audio: Buffer;
    try {
      audio = await this.mediaRepository.extractAudio(asset.originalPath, audioStreamIndex);
    } catch (error) {
      this.logger.warn(`Could not extract the audio of asset ${id}: ${error}`);
      // stored as empty so a broken file is not queued again by every "missing" run
      await this.transcriptRepository.replace({ assetId: id, language: null, modelName }, []);
      return JobStatus.Failed;
    }

    // machine learning errors fail the job so it is retried like the other machine learning jobs
    const result = await this.machineLearningRepository.transcribe(audio, { modelName, language, computeType });

    const { machineLearning: newConfig } = await this.getConfig({ withCache: true });
    if (newConfig.videoTranscription.modelName !== modelName) {
      // made by a model that is no longer used, the next run uses the new one
      return JobStatus.Skipped;
    }

    const segments = toTranscriptSegments(result.segments);
    await this.transcriptRepository.replace(
      {
        assetId: id,
        language: segments.length > 0 ? (result.language ?? null) : null,
        modelName: result.modelName ?? modelName,
      },
      segments,
    );
    this.logger.debug(`Transcribed ${segments.length} lines of speech in video ${id}`);

    return JobStatus.Success;
  }
}
