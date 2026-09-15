import { Injectable } from '@nestjs/common';
import { Duration } from 'luxon';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MachineLearningConfig } from 'src/dtos/config.dto';
import { LoggingRepository } from 'src/repositories/logging.repository';

export interface BoundingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export enum ModelTask {
  FACIAL_RECOGNITION = 'facial-recognition',
  FACE_ATTRIBUTES = 'face-attributes',
  IMAGE_QUALITY = 'image-quality',
  SEARCH = 'clip',
  OCR = 'ocr',
}

export enum ModelType {
  DETECTION = 'detection',
  LANDMARKS = 'landmarks',
  PIPELINE = 'pipeline',
  QUALITY = 'quality',
  RECOGNITION = 'recognition',
  TEXTUAL = 'textual',
  VISUAL = 'visual',
  OCR = 'ocr',
}

export type ModelPayload = { imagePath: string } | { image: Buffer } | { text: string };

type ModelOptions = { modelName: string };

export type FaceDetectionOptions = ModelOptions & { minScore: number };
export type OcrOptions = ModelOptions & {
  minDetectionScore: number;
  minRecognitionScore: number;
  maxResolution: number;
};
type VisualResponse = { imageHeight: number; imageWidth: number };
export type ClipVisualRequest = { [ModelTask.SEARCH]: { [ModelType.VISUAL]: ModelOptions } };
export type ClipVisualResponse = { [ModelTask.SEARCH]: string } & VisualResponse;

export type ClipTextualRequest = { [ModelTask.SEARCH]: { [ModelType.TEXTUAL]: ModelOptions } };
export type ClipTextualResponse = { [ModelTask.SEARCH]: string };

export type OCR = {
  text: string[];
  box: number[];
  boxScore: number[];
  textScore: number[];
};

export type OcrRequest = {
  [ModelTask.OCR]: {
    [ModelType.DETECTION]: ModelOptions & { options: { minScore: number; maxResolution: number } };
    [ModelType.RECOGNITION]: ModelOptions & { options: { minScore: number } };
  };
};
export type OcrResponse = { [ModelTask.OCR]: OCR } & VisualResponse;

export type FacialRecognitionRequest = {
  [ModelTask.FACIAL_RECOGNITION]: {
    [ModelType.DETECTION]: ModelOptions & { options: { minScore: number } };
    [ModelType.RECOGNITION]: ModelOptions;
  };
};

export interface Face {
  boundingBox: BoundingBox;
  embedding: string;
  score: number;
}

export type FacialRecognitionResponse = { [ModelTask.FACIAL_RECOGNITION]: Face[] } & VisualResponse;

/** The image quality measures have no model file, the name identifies how they were computed. */
export const IMAGE_QUALITY_MODEL_NAME = 'laplacian';

/** A face box in the coordinates of the image size it was stored with. */
export type FaceAttributesBox = BoundingBox & { imageWidth: number; imageHeight: number };
export type FaceAttributesOptions = ModelOptions & { faces: FaceAttributesBox[] };

export type FaceAttributes = {
  detected: boolean;
  eyeBlinkLeft: number | null;
  eyeBlinkRight: number | null;
  smile: number | null;
  yaw: number | null;
  pitch: number | null;
  roll: number | null;
  sharpness: number | null;
};

export type ImageQuality = { sharpness: number; exposureClipped: number; brightness: number };

export type FaceAttributesRequest = {
  [ModelTask.FACE_ATTRIBUTES]: {
    [ModelType.LANDMARKS]: ModelOptions & { options: { faces: FaceAttributesBox[] } };
  };
  [ModelTask.IMAGE_QUALITY]: { [ModelType.QUALITY]: ModelOptions };
};
export type FaceAttributesResponse = {
  [ModelTask.FACE_ATTRIBUTES]: FaceAttributes[];
  [ModelTask.IMAGE_QUALITY]: ImageQuality;
} & VisualResponse;

export type ImageAnalysisRequest = Partial<ClipVisualRequest & FacialRecognitionRequest>;
export type ImageAnalysisResponse = Partial<
  { [ModelTask.SEARCH]: string } & { [ModelTask.FACIAL_RECOGNITION]: Face[] }
> &
  VisualResponse;

export type MachineLearningRequest =
  | ClipVisualRequest
  | ClipTextualRequest
  | FacialRecognitionRequest
  | FaceAttributesRequest
  | OcrRequest
  | ImageAnalysisRequest;
export type TextEncodingOptions = ModelOptions & { language?: string };

@Injectable()
export class MachineLearningRepository {
  private healthyMap: Record<string, boolean> = {};
  private interval?: ReturnType<typeof setInterval>;
  private _config?: MachineLearningConfig;

  private get config(): MachineLearningConfig {
    if (!this._config) {
      throw new Error('Machine learning repository not been setup');
    }

    return this._config;
  }

  constructor(private logger: LoggingRepository) {
    this.logger.setContext(MachineLearningRepository.name);
  }

  setup(config: MachineLearningConfig) {
    this._config = config;
    this.teardown();

    // delete old servers
    for (const url of Object.keys(this.healthyMap)) {
      if (!config.urls.includes(url)) {
        delete this.healthyMap[url];
      }
    }

    if (!config.enabled || !config.availabilityChecks.enabled) {
      return;
    }

    this.tick();
    this.interval = setInterval(
      () => this.tick(),
      Duration.fromObject({ milliseconds: config.availabilityChecks.interval }).as('milliseconds'),
    );
  }

  teardown() {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  private tick() {
    for (const url of this.config.urls) {
      void this.check(url);
    }
  }

  private async check(url: string) {
    let isHealthy = false;
    try {
      const response = await fetch(new URL('ping', url), {
        signal: AbortSignal.timeout(this.config.availabilityChecks.timeout),
      });
      if (response.ok) {
        isHealthy = true;
      }
    } catch {
      // nothing to do here
    }

    this.setHealthy(url, isHealthy);
  }

  private setHealthy(url: string, healthy: boolean) {
    if (this.healthyMap[url] !== healthy) {
      this.logger.log(`Machine learning server became ${healthy ? 'healthy' : 'unhealthy'} (${url}).`);
    }

    this.healthyMap[url] = healthy;
  }

  private isHealthy(url: string) {
    if (!this.config.availabilityChecks.enabled) {
      return true;
    }

    return this.healthyMap[url];
  }

  private async predict<T>(payload: ModelPayload, config: MachineLearningRequest): Promise<T> {
    const { body, contentType } = await this.getRequestBody(payload, config);

    for (const url of [
      // try healthy servers first
      ...this.config.urls.filter((url) => this.isHealthy(url)),
      ...this.config.urls.filter((url) => !this.isHealthy(url)),
    ]) {
      try {
        const response = await fetch(new URL('predict', url), {
          method: 'POST',
          body,
          headers: { 'Content-Type': contentType },
        });
        if (response.ok) {
          this.setHealthy(url, true);
          return response.json();
        }

        this.logger.warn(
          `Machine learning request to "${url}" failed with status ${response.status}: ${response.statusText}`,
        );
      } catch (error: Error | unknown) {
        this.logger.warn(`Machine learning request to "${url}" failed`, error);
      }

      this.setHealthy(url, false);
    }

    throw new Error(`Machine learning request '${JSON.stringify(config)}' failed for all URLs`);
  }

  async detectFaces(imagePath: string, { modelName, minScore }: FaceDetectionOptions) {
    const request = {
      [ModelTask.FACIAL_RECOGNITION]: {
        [ModelType.DETECTION]: { modelName, options: { minScore } },
        [ModelType.RECOGNITION]: { modelName },
      },
    };
    const response = await this.predict<FacialRecognitionResponse>({ imagePath }, request);
    return {
      imageHeight: response.imageHeight,
      imageWidth: response.imageWidth,
      faces: response[ModelTask.FACIAL_RECOGNITION],
    };
  }

  /**
   * Describes the given faces (in request order) and measures the image quality in one request.
   * Faces are not detected again.
   */
  async detectFaceAttributes(imagePath: string, { modelName, faces }: FaceAttributesOptions) {
    const request = {
      [ModelTask.FACE_ATTRIBUTES]: { [ModelType.LANDMARKS]: { modelName, options: { faces } } },
      [ModelTask.IMAGE_QUALITY]: { [ModelType.QUALITY]: { modelName: IMAGE_QUALITY_MODEL_NAME } },
    };
    const response = await this.predict<FaceAttributesResponse>({ imagePath }, request);
    return {
      faces: response[ModelTask.FACE_ATTRIBUTES],
      quality: response[ModelTask.IMAGE_QUALITY],
    };
  }

  async encodeImage(imagePath: string, { modelName }: MachineLearningConfig['clip']) {
    const request = { [ModelTask.SEARCH]: { [ModelType.VISUAL]: { modelName } } };
    const response = await this.predict<ClipVisualResponse>({ imagePath }, request);
    return response[ModelTask.SEARCH];
  }

  /** runs smart search encoding and face detection on one in-memory image in a single request */
  async analyzeImage(
    image: Buffer,
    { clip, facialRecognition }: { clip?: ModelOptions; facialRecognition?: FaceDetectionOptions },
  ): Promise<{ imageHeight: number; imageWidth: number; clip?: string; faces?: Face[] }> {
    const request: ImageAnalysisRequest = {};
    if (clip) {
      request[ModelTask.SEARCH] = { [ModelType.VISUAL]: { modelName: clip.modelName } };
    }

    if (facialRecognition) {
      const { modelName, minScore } = facialRecognition;
      request[ModelTask.FACIAL_RECOGNITION] = {
        [ModelType.DETECTION]: { modelName, options: { minScore } },
        [ModelType.RECOGNITION]: { modelName },
      };
    }

    const response = await this.predict<ImageAnalysisResponse>({ image }, request);
    return {
      imageHeight: response.imageHeight,
      imageWidth: response.imageWidth,
      clip: response[ModelTask.SEARCH],
      faces: response[ModelTask.FACIAL_RECOGNITION],
    };
  }

  async encodeText(text: string, { language, modelName }: TextEncodingOptions) {
    const request = { [ModelTask.SEARCH]: { [ModelType.TEXTUAL]: { modelName, options: { language } } } };
    const response = await this.predict<ClipTextualResponse>({ text }, request);
    return response[ModelTask.SEARCH];
  }

  async ocr(imagePath: string, { modelName, minDetectionScore, minRecognitionScore, maxResolution }: OcrOptions) {
    const request = {
      [ModelTask.OCR]: {
        [ModelType.DETECTION]: { modelName, options: { minScore: minDetectionScore, maxResolution } },
        [ModelType.RECOGNITION]: { modelName, options: { minScore: minRecognitionScore } },
      },
    };
    const response = await this.predict<OcrResponse>({ imagePath }, request);
    return response[ModelTask.OCR];
  }

  /**
   * The request as multipart form data, encoded by hand: a Blob in a FormData body is read through `Blob.stream()`,
   * which keeps the data of every blob it read in memory until the process exits (Node 24 and 26), so every image
   * sent to machine learning was retained.
   */
  private async getRequestBody(payload: ModelPayload, config: MachineLearningRequest) {
    const boundary = `immich-${randomUUID()}`;
    const parts: Buffer[] = [];
    const addPart = (name: string, value: string | Buffer, filename?: string) => {
      const headers = [`--${boundary}`, `Content-Disposition: form-data; name="${name}"`];
      if (filename) {
        headers[1] += `; filename="${filename}"`;
        headers.push('Content-Type: application/octet-stream');
      }
      parts.push(
        Buffer.from(`${headers.join('\r\n')}\r\n\r\n`),
        typeof value === 'string' ? Buffer.from(value) : value,
        Buffer.from('\r\n'),
      );
    };

    addPart('entries', JSON.stringify(config));

    if ('imagePath' in payload) {
      addPart('image', await readFile(payload.imagePath), 'blob');
    } else if ('image' in payload) {
      addPart('image', payload.image, 'blob');
    } else if ('text' in payload) {
      addPart('text', payload.text);
    } else {
      throw new Error('Invalid input');
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
  }
}
