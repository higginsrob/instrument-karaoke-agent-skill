"""Speech-to-text on vocals stems for lyric timing (faster-whisper)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from server.config import settings

logger = logging.getLogger(__name__)

_model = None
_model_key: Optional[tuple[str, str, str]] = None


@dataclass(frozen=True)
class SttWord:
    start: float
    end: float
    word: str


@dataclass(frozen=True)
class SttSegment:
    start: float
    end: float
    text: str


def _compute_type(device: str) -> str:
    if settings.whisper_compute_type:
        return settings.whisper_compute_type
    return "float16" if device == "cuda" else "int8"


def _get_model(device: str):
    global _model, _model_key
    device = "cuda" if device == "cuda" else "cpu"
    compute = _compute_type(device)
    key = (settings.whisper_model, device, compute)
    if _model is not None and _model_key == key:
        return _model
    from faster_whisper import WhisperModel

    models_dir = Path(settings.models_dir)
    models_dir.mkdir(parents=True, exist_ok=True)
    logger.info(
        "Loading faster-whisper model=%s device=%s compute_type=%s download_root=%s",
        settings.whisper_model,
        device,
        compute,
        models_dir,
    )
    _model = WhisperModel(
        settings.whisper_model,
        device=device,
        compute_type=compute,
        download_root=str(models_dir),
    )
    _model_key = key
    return _model


def transcribe_vocals(
    vocals_path: Path,
    *,
    device: str = "cpu",
) -> tuple[list[SttWord], list[SttSegment]]:
    """
    Transcribe vocals.wav with word timestamps.

    Returns a flat word stream and segment-level cues (for debug VTT).
    """
    if not vocals_path.is_file():
        raise FileNotFoundError(f"Missing vocals stem: {vocals_path}")

    model = _get_model(device)
    segments_iter, _info = model.transcribe(
        str(vocals_path),
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
    )

    words: list[SttWord] = []
    segments: list[SttSegment] = []
    for seg in segments_iter:
        text = (seg.text or "").strip()
        if text:
            segments.append(
                SttSegment(
                    start=float(seg.start or 0.0),
                    end=float(seg.end or seg.start or 0.0),
                    text=text,
                )
            )
        for w in seg.words or []:
            token = (w.word or "").strip()
            if not token:
                continue
            start = float(w.start if w.start is not None else seg.start or 0.0)
            end = float(w.end if w.end is not None else start + 0.05)
            words.append(SttWord(start=start, end=max(end, start + 0.02), word=token))

    logger.info(
        "STT produced %d words across %d segments from %s",
        len(words),
        len(segments),
        vocals_path.name,
    )
    return words, segments
