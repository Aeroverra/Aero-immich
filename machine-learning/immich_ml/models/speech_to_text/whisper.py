from __future__ import annotations

import gc
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import onnxruntime as ort
from huggingface_hub import snapshot_download
from numpy.typing import NDArray

from immich_ml.config import log, settings
from immich_ml.models.base import InferenceModel
from immich_ml.models.constants import WHISPER_REPOS
from immich_ml.schemas import ModelTask, ModelType, TranscriptionOutput, TranscriptionSegment

if TYPE_CHECKING:
    from faster_whisper import WhisperModel

COMPUTE_TYPES = {"auto", "int8", "int8_float16", "int8_float32", "float16", "float32"}

# files of a CTranslate2 Whisper conversion, the same ones faster-whisper downloads itself
MODEL_FILES = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]


class WhisperTranscriber(InferenceModel):
    """
    Transcribes 16 kHz mono audio with a CTranslate2 conversion of Whisper through faster-whisper.
    The model runs on CUDA when the CUDA build of ONNX Runtime is installed and a GPU is visible, otherwise on CPU.
    """

    depends = []
    identity = (ModelType.TRANSCRIPTION, ModelTask.SPEECH_TO_TEXT)

    def __init__(self, model_name: str, computeType: str = "auto", **model_kwargs: Any) -> None:
        super().__init__(model_name, **model_kwargs)
        self.device = self._device_default
        self.compute_type = self._resolve_compute_type(computeType)
        self.reload_lock = threading.Lock()

    def _download(self) -> None:
        snapshot_download(
            WHISPER_REPOS[self.model_name],
            cache_dir=self.cache_dir,
            local_dir=self.model_dir,
            allow_patterns=MODEL_FILES,
        )

    def _load(self) -> WhisperModel:
        from faster_whisper import WhisperModel

        log.info(f"Using {self.device} with compute type {self.compute_type} for model '{self.model_name}'")
        return WhisperModel(
            self.model_dir.as_posix(),
            device=self.device,
            device_index=int(settings.device_id) if self.device == "cuda" else 0,
            compute_type=self.compute_type,
            # its own cap, so one long transcription on a CPU leaves the other cores to the other models
            cpu_threads=settings.transcription_threads,
        )

    def configure(self, computeType: str | None = None, **kwargs: Any) -> None:
        if computeType is None:
            return
        compute_type = self._resolve_compute_type(computeType)
        if compute_type == self.compute_type:
            return

        with self.reload_lock:
            if compute_type == self.compute_type:
                return
            self.compute_type = compute_type
            if not self.loaded:
                return
            log.info(f"Reloading model '{self.model_name}' with compute type {compute_type}")
            # the previous model is released first so both are never in memory at the same time
            del self.session
            gc.collect()
            self.session = self._load()

    def _predict(
        self,
        inputs: NDArray[np.float32],
        language: str | None = None,
        vadFilter: bool = True,
        beamSize: int = 5,
        **kwargs: Any,
    ) -> TranscriptionOutput:
        segments, info = self.session.transcribe(  # type: ignore[attr-defined]
            inputs, language=language or None, vad_filter=vadFilter, beam_size=beamSize
        )
        # segments are decoded lazily while iterating
        transcribed: list[TranscriptionSegment] = [
            {"start": round(segment.start, 2), "end": round(segment.end, 2), "text": text}
            for segment in segments
            if (text := segment.text.strip())
        ]
        return {
            "language": info.language,
            "languageProbability": info.language_probability,
            "duration": round(info.duration, 2),
            "segments": transcribed,
        }

    def _resolve_compute_type(self, compute_type: str) -> str:
        if compute_type not in COMPUTE_TYPES:
            raise ValueError(f"Unsupported compute type '{compute_type}', expected one of {sorted(COMPUTE_TYPES)}")
        if compute_type == "auto":
            return "int8_float16" if self.device == "cuda" else "int8"
        return compute_type

    @property
    def _device_default(self) -> str:
        import ctranslate2

        if "CUDAExecutionProvider" in ort.get_available_providers() and ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
        return "cpu"

    @property
    def model_path(self) -> Path:
        return self.model_dir / "model.bin"
