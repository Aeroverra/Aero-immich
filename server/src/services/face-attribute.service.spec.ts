import { AssetVisibility, ImmichWorker, JobName, JobStatus } from 'src/enum';
import { FaceAttributeService } from 'src/services/face-attribute.service';
import { AssetFactory } from 'test/factories/asset.factory';
import { systemConfigStub } from 'test/fixtures/system-config.stub';
import { newUuid } from 'test/small.factory';
import { makeStream, newTestService, ServiceMocks } from 'test/utils';

const previewFile = '/uploads/user-id/thumbs/path.jpg';
const quality = { sharpness: 120.5, exposureClipped: 0.02, brightness: 0.45 };
const detected = {
  detected: true,
  eyeBlinkLeft: 0.05,
  eyeBlinkRight: 0.07,
  smile: 0.8,
  yaw: 4.5,
  pitch: -2,
  roll: 1,
  sharpness: 300,
};
const undetected = {
  detected: false,
  eyeBlinkLeft: null,
  eyeBlinkRight: null,
  smile: null,
  yaw: null,
  pitch: null,
  roll: null,
  sharpness: 12,
};

const newFace = (box: { x1: number; y1: number; x2: number; y2: number }) => ({
  id: newUuid(),
  imageWidth: 1440,
  imageHeight: 1080,
  boundingBoxX1: box.x1,
  boundingBoxY1: box.y1,
  boundingBoxX2: box.x2,
  boundingBoxY2: box.y2,
});

describe(FaceAttributeService.name, () => {
  let sut: FaceAttributeService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(FaceAttributeService));

    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
    mocks.faceAttribute.upsert.mockResolvedValue();
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('handleQueueFaceAttributes', () => {
    it('should do nothing if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      await expect(sut.handleQueueFaceAttributes({ force: false })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.faceAttribute.streamForFaceAttributesJob).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should do nothing if face attributes are disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { faceAttributes: { enabled: false } } });

      await expect(sut.handleQueueFaceAttributes({ force: false })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.faceAttribute.streamForFaceAttributesJob).not.toHaveBeenCalled();
    });

    it('should queue the assets that are missing results', async () => {
      const asset = AssetFactory.create();
      mocks.faceAttribute.streamForFaceAttributesJob.mockReturnValue(makeStream([asset]));

      await expect(sut.handleQueueFaceAttributes({ force: false })).resolves.toBe(JobStatus.Success);

      expect(mocks.faceAttribute.streamForFaceAttributesJob).toHaveBeenCalledWith({
        force: false,
        facesDetected: true,
      });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetDetectFaceAttributes, data: { id: asset.id } },
      ]);
    });

    it('should queue all assets', async () => {
      const asset = AssetFactory.create();
      mocks.faceAttribute.streamForFaceAttributesJob.mockReturnValue(makeStream([asset]));

      await sut.handleQueueFaceAttributes({ force: true });

      expect(mocks.faceAttribute.streamForFaceAttributesJob).toHaveBeenCalledWith({ force: true, facesDetected: true });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetDetectFaceAttributes, data: { id: asset.id } },
      ]);
    });

    it('should not wait for face detection when facial recognition is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { enabled: false } } });
      mocks.faceAttribute.streamForFaceAttributesJob.mockReturnValue(makeStream([]));

      await sut.handleQueueFaceAttributes({ force: false });

      expect(mocks.faceAttribute.streamForFaceAttributesJob).toHaveBeenCalledWith({
        force: false,
        facesDetected: false,
      });
    });
  });

  describe('handleDetectFaceAttributes', () => {
    it('should do nothing if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      await expect(sut.handleDetectFaceAttributes({ id: newUuid() })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.faceAttribute.getForFaceAttributesJob).not.toHaveBeenCalled();
      expect(mocks.machineLearning.detectFaceAttributes).not.toHaveBeenCalled();
    });

    it('should fail if the asset does not exist', async () => {
      mocks.faceAttribute.getForFaceAttributesJob.mockResolvedValue(void 0);

      await expect(sut.handleDetectFaceAttributes({ id: newUuid() })).resolves.toBe(JobStatus.Failed);

      expect(mocks.machineLearning.detectFaceAttributes).not.toHaveBeenCalled();
    });

    it('should fail if the asset has no preview', async () => {
      const id = newUuid();
      mocks.faceAttribute.getForFaceAttributesJob.mockResolvedValue({
        id,
        visibility: AssetVisibility.Timeline,
        previewFile: null,
        faces: [],
      });

      await expect(sut.handleDetectFaceAttributes({ id })).resolves.toBe(JobStatus.Failed);

      expect(mocks.machineLearning.detectFaceAttributes).not.toHaveBeenCalled();
      expect(mocks.faceAttribute.upsert).not.toHaveBeenCalled();
    });

    it('should skip hidden assets', async () => {
      const id = newUuid();
      mocks.faceAttribute.getForFaceAttributesJob.mockResolvedValue({
        id,
        visibility: AssetVisibility.Hidden,
        previewFile,
        faces: [],
      });

      await expect(sut.handleDetectFaceAttributes({ id })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.machineLearning.detectFaceAttributes).not.toHaveBeenCalled();
    });

    it('should store the image quality of an asset without faces', async () => {
      const id = newUuid();
      mocks.faceAttribute.getForFaceAttributesJob.mockResolvedValue({
        id,
        visibility: AssetVisibility.Timeline,
        previewFile,
        faces: [],
      });
      mocks.machineLearning.detectFaceAttributes.mockResolvedValue({ faces: [], quality });

      await expect(sut.handleDetectFaceAttributes({ id })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearning.detectFaceAttributes).toHaveBeenCalledWith(previewFile, {
        modelName: 'face_landmarker',
        faces: [],
      });
      expect(mocks.faceAttribute.upsert).toHaveBeenCalledWith({ assetId: id, ...quality, modelName: 'laplacian' }, []);
    });

    it('should send the stored face boxes and store the attributes by face', async () => {
      const id = newUuid();
      const first = newFace({ x1: 100, y1: 120, x2: 300, y2: 360 });
      const second = newFace({ x1: 700, y1: 200, x2: 820, y2: 350 });
      mocks.faceAttribute.getForFaceAttributesJob.mockResolvedValue({
        id,
        visibility: AssetVisibility.Timeline,
        previewFile,
        faces: [first, second],
      });
      mocks.machineLearning.detectFaceAttributes.mockResolvedValue({ faces: [detected, undetected], quality });

      await expect(sut.handleDetectFaceAttributes({ id })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearning.detectFaceAttributes).toHaveBeenCalledWith(previewFile, {
        modelName: 'face_landmarker',
        faces: [
          { x1: 100, y1: 120, x2: 300, y2: 360, imageWidth: 1440, imageHeight: 1080 },
          { x1: 700, y1: 200, x2: 820, y2: 350, imageWidth: 1440, imageHeight: 1080 },
        ],
      });
      expect(mocks.faceAttribute.upsert).toHaveBeenCalledWith({ assetId: id, ...quality, modelName: 'laplacian' }, [
        { faceId: first.id, ...detected, modelName: 'face_landmarker' },
        { faceId: second.id, ...undetected, modelName: 'face_landmarker' },
      ]);
    });

    it('should process private assets like any other asset', async () => {
      const asset = AssetFactory.create({ isPrivate: true });
      const face = newFace({ x1: 1, y1: 2, x2: 3, y2: 4 });
      mocks.faceAttribute.getForFaceAttributesJob.mockResolvedValue({
        id: asset.id,
        visibility: AssetVisibility.Timeline,
        previewFile,
        faces: [face],
      });
      mocks.machineLearning.detectFaceAttributes.mockResolvedValue({ faces: [detected], quality });

      await expect(sut.handleDetectFaceAttributes({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.faceAttribute.upsert).toHaveBeenCalledOnce();
    });

    it('should use the configured model', async () => {
      const id = newUuid();
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { faceAttributes: { enabled: true, modelName: 'custom_landmarker' } },
      });
      const face = newFace({ x1: 1, y1: 2, x2: 3, y2: 4 });
      mocks.faceAttribute.getForFaceAttributesJob.mockResolvedValue({
        id,
        visibility: AssetVisibility.Archive,
        previewFile,
        faces: [face],
      });
      mocks.machineLearning.detectFaceAttributes.mockResolvedValue({ faces: [detected], quality });

      await expect(sut.handleDetectFaceAttributes({ id })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearning.detectFaceAttributes).toHaveBeenCalledWith(
        previewFile,
        expect.objectContaining({ modelName: 'custom_landmarker' }),
      );
      expect(mocks.faceAttribute.upsert).toHaveBeenCalledWith(expect.anything(), [
        { faceId: face.id, ...detected, modelName: 'custom_landmarker' },
      ]);
    });

    it('should fail without storing anything when the response does not match the faces', async () => {
      const id = newUuid();
      mocks.faceAttribute.getForFaceAttributesJob.mockResolvedValue({
        id,
        visibility: AssetVisibility.Timeline,
        previewFile,
        faces: [newFace({ x1: 1, y1: 2, x2: 3, y2: 4 })],
      });
      mocks.machineLearning.detectFaceAttributes.mockResolvedValue({ faces: [], quality });

      await expect(sut.handleDetectFaceAttributes({ id })).resolves.toBe(JobStatus.Failed);

      expect(mocks.faceAttribute.upsert).not.toHaveBeenCalled();
    });

    it('should never change faces or people', async () => {
      const id = newUuid();
      mocks.faceAttribute.getForFaceAttributesJob.mockResolvedValue({
        id,
        visibility: AssetVisibility.Timeline,
        previewFile,
        faces: [newFace({ x1: 1, y1: 2, x2: 3, y2: 4 })],
      });
      mocks.machineLearning.detectFaceAttributes.mockResolvedValue({ faces: [detected], quality });

      await sut.handleDetectFaceAttributes({ id });

      expect(mocks.machineLearning.detectFaces).not.toHaveBeenCalled();
      expect(mocks.person.refreshFaces).not.toHaveBeenCalled();
      expect(mocks.person.deleteFaces).not.toHaveBeenCalled();
      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });
  });
});
