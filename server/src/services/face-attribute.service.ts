import { Injectable } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { AssetVisibility, JobName, JobStatus, QueueName } from 'src/enum';
import { IMAGE_QUALITY_MODEL_NAME } from 'src/repositories/machine-learning.repository';
import { BaseService } from 'src/services/base.service';
import { JobOf } from 'src/types';
import { batched, isFaceAttributesEnabled, isFacialRecognitionEnabled } from 'src/utils/misc';

@Injectable()
export class FaceAttributeService extends BaseService {
  @OnJob({ name: JobName.AssetDetectFaceAttributesQueueAll, queue: QueueName.FaceAttributes })
  async handleQueueFaceAttributes({ force }: JobOf<JobName.AssetDetectFaceAttributesQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isFaceAttributesEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    // assets waiting for face detection are queued once detection finishes
    const facesDetected = isFacialRecognitionEnabled(machineLearning);
    const assets = this.faceAttributeRepository.streamForFaceAttributesJob({ force, facesDetected });
    for await (const batch of batched(assets)) {
      await this.jobRepository.queueAll(
        batch.map((asset) => ({ name: JobName.AssetDetectFaceAttributes, data: { id: asset.id } })),
      );
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetDetectFaceAttributes, queue: QueueName.FaceAttributes })
  async handleDetectFaceAttributes({ id }: JobOf<JobName.AssetDetectFaceAttributes>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isFaceAttributesEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const asset = await this.faceAttributeRepository.getForFaceAttributesJob(id);
    if (!asset || !asset.previewFile) {
      return JobStatus.Failed;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      return JobStatus.Skipped;
    }

    const { modelName } = machineLearning.faceAttributes;
    const { faces, quality } = await this.machineLearningRepository.detectFaceAttributes(asset.previewFile, {
      modelName,
      faces: asset.faces.map((face) => ({
        x1: face.boundingBoxX1,
        y1: face.boundingBoxY1,
        x2: face.boundingBoxX2,
        y2: face.boundingBoxY2,
        imageWidth: face.imageWidth,
        imageHeight: face.imageHeight,
      })),
    });

    if (faces.length !== asset.faces.length) {
      this.logger.warn(`Expected ${asset.faces.length} face attributes for asset ${id}, received ${faces.length}`);
      return JobStatus.Failed;
    }

    await this.faceAttributeRepository.upsert(
      { assetId: id, ...quality, modelName: IMAGE_QUALITY_MODEL_NAME },
      faces.map((attributes, index) => ({ faceId: asset.faces[index].id, ...attributes, modelName })),
    );

    this.logger.debug(`Stored attributes of ${faces.length} face(s) and the image quality of asset ${id}`);
    return JobStatus.Success;
  }
}
