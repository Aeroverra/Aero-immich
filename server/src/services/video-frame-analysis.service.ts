import { Injectable } from '@nestjs/common';
import { Insertable } from 'kysely';
import { OnJob } from 'src/decorators';
import { AssetType, AssetVisibility, DatabaseLock, JobName, JobStatus, QueueName } from 'src/enum';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table';
import { FaceSearchTable } from 'src/schema/tables/face-search.table';
import { BaseService } from 'src/services/base.service';
import { JobItem, JobOf, VideoStreamInfo } from 'src/types';
import { VideoFrameConfig } from 'src/utils/media';
import {
  batched,
  isSmartSearchEnabled,
  isVideoFrameAnalysisEnabled,
  isVideoFrameFaceDetectionEnabled,
} from 'src/utils/misc';
import {
  cosineDistance,
  getFaceSize,
  getVideoFrameTimestamps,
  groupVideoFrameFaces,
  parseEmbedding,
  removeDuplicateFrames,
  VideoFrameEmbedding,
  VideoFrameFace,
} from 'src/utils/video-frame';

/** frames closer than this to the previous kept frame or the thumbnail add nothing to search */
const DUPLICATE_FRAME_MAX_DISTANCE = 0.03;
/** faces of one video closer than this are treated as the same person */
const FACE_GROUP_MAX_DISTANCE = 0.4;
/** a person seen in only one sampled frame needs a clearer detection than usual */
const SINGLE_FRAME_FACE_MIN_SCORE = 0.8;
/** the smallest face kept, relative to the shorter side of the frame */
const MIN_FACE_SIZE_RATIO = 0.03;

@Injectable()
export class VideoFrameAnalysisService extends BaseService {
  @OnJob({ name: JobName.AssetAnalyzeVideoFramesQueueAll, queue: QueueName.VideoFrameAnalysis })
  async handleQueueAnalyzeVideoFrames({ force }: JobOf<JobName.AssetAnalyzeVideoFramesQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isVideoFrameAnalysisEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    // faces found in the thumbnails must exist first, so people already on a video are not added twice
    await this.jobRepository.waitForQueueCompletion(QueueName.ThumbnailGeneration, QueueName.FaceDetection);

    for await (const assets of batched(this.assetJobRepository.streamForVideoFrameAnalysis(force))) {
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.AssetAnalyzeVideoFrames, data: { id: asset.id } })),
      );
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetAnalyzeVideoFrames, queue: QueueName.VideoFrameAnalysis })
  async handleAnalyzeVideoFrames({ id }: JobOf<JobName.AssetAnalyzeVideoFrames>): Promise<JobStatus> {
    const { machineLearning, ffmpeg, image } = await this.getConfig({ withCache: true });
    if (!isVideoFrameAnalysisEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForVideoFrameAnalysis(id);
    if (!asset) {
      return JobStatus.Failed;
    }

    if (asset.type !== AssetType.Video || asset.visibility === AssetVisibility.Hidden || asset.deletedAt) {
      return JobStatus.Skipped;
    }

    let videoStream: VideoStreamInfo | null = asset.videoStream;
    let duration = asset.duration;
    if (!videoStream || !duration) {
      // videos imported before stream details were stored in the database only have them in the file
      try {
        const probed = await this.mediaRepository.probe(asset.originalPath);
        videoStream ??= probed.videoStreams[0] ?? null;
        duration ||= probed.format.duration ? Math.round(probed.format.duration * 1000) : null;
      } catch (error) {
        this.logger.warn(`Could not probe asset ${id} for video frame analysis: ${error}`);
      }
    }

    if (!videoStream) {
      this.logger.warn(`Video frame analysis failed for asset ${id}: missing video metadata`);
      // marked as analyzed anyway so an unreadable file is not queued again by every "missing" run
      await this.assetRepository.upsertJobStatus({ assetId: id, videoFramesAnalyzedAt: new Date() });
      return JobStatus.Failed;
    }

    const { frameDensity, minFrameInterval, maxFrames } = machineLearning.videoFrameAnalysis;
    const timestamps = getVideoFrameTimestamps(duration, { frameDensity, minFrameInterval, maxFrames });
    if (timestamps.length === 0) {
      this.logger.debug(`Skipping video frame analysis for asset ${id}: unknown duration`);
      await this.assetRepository.upsertJobStatus({ assetId: id, videoFramesAnalyzedAt: new Date() });
      return JobStatus.Skipped;
    }

    const clip = isSmartSearchEnabled(machineLearning) ? machineLearning.clip : undefined;
    const facialRecognition = isVideoFrameFaceDetectionEnabled(machineLearning)
      ? machineLearning.facialRecognition
      : undefined;

    const frameConfig = VideoFrameConfig.create({ ...ffmpeg, targetResolution: image.preview.size.toString() });
    const frames: VideoFrameEmbedding[] = [];
    const faces: VideoFrameFace[] = [];
    let extractedFrames = 0;

    for (const frameTimestamp of timestamps) {
      let frame: Buffer;
      try {
        frame = await this.mediaRepository.extractVideoFrame(
          asset.originalPath,
          frameConfig.getFrameCommand(frameTimestamp, videoStream),
        );
      } catch (error) {
        this.logger.warn(`Could not extract the frame at ${frameTimestamp}ms of asset ${id}: ${error}`);
        continue;
      }

      extractedFrames++;
      // machine learning errors fail the job so it is retried like the other machine learning jobs
      const result = await this.machineLearningRepository.analyzeImage(frame, { clip, facialRecognition });
      if (result.clip) {
        frames.push({ frameTimestamp, embedding: result.clip });
      }

      for (const face of result.faces ?? []) {
        faces.push({ ...face, frameTimestamp, imageWidth: result.imageWidth, imageHeight: result.imageHeight });
      }
    }

    if (extractedFrames === 0) {
      this.logger.warn(`Video frame analysis failed for asset ${id}: no frame could be extracted`);
      // marked as analyzed anyway so a broken file is not queued again by every "missing" run
      await this.assetRepository.upsertJobStatus({ assetId: id, videoFramesAnalyzedAt: new Date() });
      return JobStatus.Failed;
    }

    if (clip) {
      if (this.databaseRepository.isBusy(DatabaseLock.CLIPDimSize)) {
        this.logger.verbose(`Waiting for CLIP dimension size to be updated`);
        await this.databaseRepository.wait(DatabaseLock.CLIPDimSize);
      }

      const { machineLearning: newConfig } = await this.getConfig({ withCache: true });
      if (clip.modelName !== newConfig.clip.modelName) {
        // the embeddings were made by a model that is no longer used
        return JobStatus.Skipped;
      }

      const kept = removeDuplicateFrames(frames, DUPLICATE_FRAME_MAX_DISTANCE, asset.thumbnailEmbedding);
      await this.searchRepository.replaceFrames(id, kept);
      this.logger.debug(`Stored ${kept.length} of ${frames.length} frame embeddings for asset ${id}`);
    }

    if (facialRecognition) {
      await this.addFaces(asset, faces, facialRecognition, timestamps.length);
    }

    await this.assetRepository.upsertJobStatus({ assetId: id, videoFramesAnalyzedAt: new Date() });

    return JobStatus.Success;
  }

  private async addFaces(
    asset: { id: string; faces: { personGroupId: string | null; embedding: string | null }[] },
    faces: VideoFrameFace[],
    { minScore, maxDistance }: { minScore: number; maxDistance: number },
    frameCount: number,
  ) {
    const candidates = faces.filter(
      (face) =>
        face.score >= minScore &&
        getFaceSize(face) >= MIN_FACE_SIZE_RATIO * Math.min(face.imageWidth, face.imageHeight),
    );

    const knownEmbeddings = asset.faces.flatMap(({ embedding }) => (embedding ? [parseEmbedding(embedding)] : []));
    const personGroupIds = [
      ...new Set(asset.faces.flatMap(({ personGroupId }) => (personGroupId ? [personGroupId] : []))),
    ];

    const facesToAdd: (Insertable<AssetFaceTable> & { id: string; assetId: string })[] = [];
    const embeddings: FaceSearchTable[] = [];

    for (const { face, frameCount: seenIn } of groupVideoFrameFaces(
      candidates,
      Math.min(maxDistance, FACE_GROUP_MAX_DISTANCE),
    )) {
      if (seenIn === 1 && frameCount > 1 && face.score < SINGLE_FRAME_FACE_MIN_SCORE) {
        continue;
      }

      // skip people already on this video: faces found in the thumbnail or earlier runs, and people
      // tagged without a face embedding (for example manual whole-frame faces) matched by their other faces
      const embedding = parseEmbedding(face.embedding);
      if (knownEmbeddings.some((known) => cosineDistance(known, embedding) <= maxDistance)) {
        continue;
      }

      const personDistance = await this.searchRepository.getMinFaceDistance(face.embedding, personGroupIds);
      if (personDistance !== null && personDistance <= maxDistance) {
        continue;
      }

      const faceId = this.cryptoRepository.randomUUID();
      facesToAdd.push({
        id: faceId,
        assetId: asset.id,
        imageWidth: face.imageWidth,
        imageHeight: face.imageHeight,
        boundingBoxX1: face.boundingBox.x1,
        boundingBoxY1: face.boundingBox.y1,
        boundingBoxX2: face.boundingBox.x2,
        boundingBoxY2: face.boundingBox.y2,
        frameTimestamp: face.frameTimestamp,
      });
      embeddings.push({ faceId, embedding: face.embedding });
      knownEmbeddings.push(embedding);
    }

    if (facesToAdd.length === 0) {
      return;
    }

    await this.personRepository.refreshFaces(facesToAdd, [], embeddings);
    this.logger.log(`Detected ${facesToAdd.length} new faces in the frames of video ${asset.id}`);

    const jobs: JobItem[] = facesToAdd.map((face) => ({ name: JobName.FacialRecognition, data: { id: face.id } }));
    await this.jobRepository.queueAll([{ name: JobName.FacialRecognitionQueueAll, data: { force: false } }, ...jobs]);
  }
}
