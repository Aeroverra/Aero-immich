from typing import Any

import cv2
from PIL import Image

from immich_ml.models.base import InferenceModel
from immich_ml.models.transforms import decode_pil, laplacian_variance, to_grayscale
from immich_ml.schemas import ImageQualityOutput, ModelTask, ModelType

# the image is downscaled first so the sharpness score does not depend on the preview resolution
ANALYSIS_SIZE = 640
# pixels this close to black or white carry no detail
CLIP_LOW = 5
CLIP_HIGH = 250


class LaplacianImageQuality(InferenceModel):
    """
    Classic image quality measures computed with OpenCV: there is no model file to download or load.

    - sharpness: variance of the Laplacian of the grayscale image downscaled to 640px on its longest side
    - exposureClipped: fraction of pixels that are nearly black or nearly white (0-1)
    - brightness: mean luma (0-1)
    """

    depends = []
    identity = (ModelType.QUALITY, ModelTask.IMAGE_QUALITY)

    def load(self) -> None:
        self.loaded = True

    @property
    def cached(self) -> bool:
        return True

    def _download(self) -> None:
        pass

    def _predict(self, inputs: Image.Image | bytes, **kwargs: Any) -> ImageQualityOutput:
        gray = to_grayscale(decode_pil(inputs))
        height, width = gray.shape[:2]
        scale = ANALYSIS_SIZE / max(height, width)
        if scale < 1:
            size = (max(1, int(width * scale)), max(1, int(height * scale)))
            gray = cv2.resize(gray, size, interpolation=cv2.INTER_AREA)  # type: ignore[assignment]

        return {
            "sharpness": laplacian_variance(gray),
            "exposureClipped": float(((gray < CLIP_LOW) | (gray > CLIP_HIGH)).mean()),
            "brightness": float(gray.mean() / 255),
        }
