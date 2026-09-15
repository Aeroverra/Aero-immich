import hashlib
import math
import threading
import urllib.request
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from numpy.typing import NDArray
from PIL import Image

from immich_ml.models.base import InferenceModel
from immich_ml.models.transforms import decode_pil, laplacian_variance
from immich_ml.schemas import FaceAttributes, FaceAttributesBox, FaceAttributesOutput, ModelTask, ModelType

# Google publishes the MediaPipe models under Apache-2.0. The versioned URL never changes, the checksum guards
# against a truncated or tampered download.
MODEL_URLS: dict[str, tuple[str, str]] = {
    "face_landmarker": (
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
    ),
}

# the face box is grown by this fraction of its size on every side so the landmarker sees the whole head
CROP_PADDING = 0.6
# longest side of the crop given to the landmarker, its own detector and landmark model work at 128px and 256px
CROP_SIZE = 256
# the face box itself is resized to this size to measure its sharpness independently of the face size
SHARPNESS_SIZE = 112
MIN_CONFIDENCE = 0.3


class FaceLandmarkerSession:
    """Runs the MediaPipe Face Landmarker task on RGB face crops."""

    def __init__(self, model_path: Path) -> None:
        from mediapipe.tasks.python.core.base_options import BaseOptions
        from mediapipe.tasks.python.vision import FaceLandmarker, FaceLandmarkerOptions, RunningMode

        options = FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=model_path.as_posix()),
            running_mode=RunningMode.IMAGE,
            num_faces=1,
            min_face_detection_confidence=MIN_CONFIDENCE,
            min_face_presence_confidence=MIN_CONFIDENCE,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
        )
        self.landmarker = FaceLandmarker.create_from_options(options)
        # a MediaPipe graph processes one image at a time
        self.lock = threading.Lock()

    def detect(self, crop: NDArray[np.uint8]) -> Any:
        from mediapipe import Image as MediaPipeImage
        from mediapipe import ImageFormat

        image = MediaPipeImage(image_format=ImageFormat.SRGB, data=np.ascontiguousarray(crop))
        with self.lock:
            return self.landmarker.detect(image)


class FaceLandmarker(InferenceModel):
    """
    Describes faces that were already detected: eye blink and smile scores (0-1) from the blendshapes,
    head pose (degrees) from the facial transformation matrix and the sharpness of the face.
    Faces are never detected again, the boxes are part of the request.
    """

    depends = []
    identity = (ModelType.LANDMARKS, ModelTask.FACE_ATTRIBUTES)

    def _download(self) -> None:
        url, sha256 = MODEL_URLS[self.model_name]
        self.model_dir.mkdir(parents=True, exist_ok=True)
        partial_path = self.model_path.with_suffix(".part")
        digest = hashlib.sha256()
        with urllib.request.urlopen(url, timeout=60) as response, partial_path.open("wb") as file:
            while chunk := response.read(1 << 20):
                digest.update(chunk)
                file.write(chunk)

        if digest.hexdigest() != sha256:
            partial_path.unlink(missing_ok=True)
            raise ValueError(f"Checksum mismatch for model '{self.model_name}' downloaded from {url}")

        partial_path.replace(self.model_path)

    def _load(self) -> Any:
        return FaceLandmarkerSession(self.model_path)

    def _predict(
        self, inputs: Image.Image | bytes, faces: list[FaceAttributesBox] | None = None, **kwargs: Any
    ) -> FaceAttributesOutput:
        if not faces:
            return []

        image = np.asarray(decode_pil(inputs), dtype=np.uint8)
        gray: NDArray[np.uint8] = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)  # type: ignore[assignment]
        return [self._describe(image, gray, face) for face in faces]

    def _describe(self, image: NDArray[np.uint8], gray: NDArray[np.uint8], face: FaceAttributesBox) -> FaceAttributes:
        undetected: FaceAttributes = {
            "detected": False,
            "eyeBlinkLeft": None,
            "eyeBlinkRight": None,
            "smile": None,
            "yaw": None,
            "pitch": None,
            "roll": None,
            "sharpness": None,
        }

        height, width = image.shape[:2]
        x1, y1, x2, y2 = scale_box(face, width, height)
        box = gray[max(0, int(y1)) : max(0, int(y2)), max(0, int(x1)) : max(0, int(x2))]
        if box.size == 0:
            return undetected

        resized_box: NDArray[np.uint8] = cv2.resize(box, (SHARPNESS_SIZE, SHARPNESS_SIZE))  # type: ignore[assignment]
        sharpness = laplacian_variance(resized_box)
        undetected["sharpness"] = sharpness

        box_width, box_height = x2 - x1, y2 - y1
        crop = image[
            max(0, int(y1 - box_height * CROP_PADDING)) : min(height, int(y2 + box_height * CROP_PADDING)),
            max(0, int(x1 - box_width * CROP_PADDING)) : min(width, int(x2 + box_width * CROP_PADDING)),
        ]
        crop_scale = CROP_SIZE / max(crop.shape[:2])
        crop_size = (max(1, int(crop.shape[1] * crop_scale)), max(1, int(crop.shape[0] * crop_scale)))

        result = self.session.detect(cv2.resize(crop, crop_size))  # type: ignore[attr-defined]
        if not result.face_blendshapes:
            return undetected

        blendshapes = {category.category_name: float(category.score) for category in result.face_blendshapes[0]}
        yaw, pitch, roll = head_pose(np.asarray(result.facial_transformation_matrixes[0]))
        return {
            "detected": True,
            "eyeBlinkLeft": blendshapes["eyeBlinkLeft"],
            "eyeBlinkRight": blendshapes["eyeBlinkRight"],
            "smile": (blendshapes["mouthSmileLeft"] + blendshapes["mouthSmileRight"]) / 2,
            "yaw": yaw,
            "pitch": pitch,
            "roll": roll,
            "sharpness": sharpness,
        }

    @property
    def model_path(self) -> Path:
        return self.model_dir / "model.task"


def scale_box(face: FaceAttributesBox, width: int, height: int) -> tuple[float, float, float, float]:
    """
    Maps a face box from the image size it was stored with to the size of the given image.
    When the stored orientation does not match the image (portrait against landscape), the box is
    rotated by 90 degrees first.
    """
    x1, y1, x2, y2 = face["x1"], face["y1"], face["x2"], face["y2"]
    image_width, image_height = face["imageWidth"], face["imageHeight"]
    if image_width <= 0 or image_height <= 0:
        return x1, y1, x2, y2

    if (width > height) != (image_width > image_height) and image_width != image_height:
        x1, y1, x2, y2 = image_height - y2, x1, image_height - y1, x2
        image_width, image_height = image_height, image_width

    scale_x, scale_y = width / image_width, height / image_height
    return x1 * scale_x, y1 * scale_y, x2 * scale_x, y2 * scale_y


def head_pose(matrix: NDArray[np.float32]) -> tuple[float, float, float]:
    """Yaw, pitch and roll in degrees from the rotation part of a 4x4 facial transformation matrix."""
    rotation = matrix[:3, :3]
    yaw = math.degrees(math.asin(max(-1.0, min(1.0, float(-rotation[2, 0])))))
    pitch = math.degrees(math.atan2(float(rotation[2, 1]), float(rotation[2, 2])))
    roll = math.degrees(math.atan2(float(rotation[1, 0]), float(rotation[0, 0])))
    return yaw, pitch, roll
