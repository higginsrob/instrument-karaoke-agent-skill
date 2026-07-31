from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    port: int = int(os.environ.get("PORT", "8093"))
    library_dir: Path = Path(os.environ.get("LIBRARY_DIR", "/library"))
    jobs_dir: Path = Path(os.environ.get("JOBS_DIR", "/data/jobs"))
    models_dir: Path = Path(os.environ.get("TORCH_HOME", "/data/models"))
    demucs_device: str = os.environ.get("DEMUCS_DEVICE", "cpu")
    demucs_model: str = os.environ.get("DEMUCS_MODEL", "htdemucs")
    demucs_overlap: float = float(os.environ.get("DEMUCS_OVERLAP", "0.1"))
    max_duration_seconds: int = int(os.environ.get("MAX_DURATION_SECONDS", "600"))
    youtube_save_video: bool = _env_bool("YOUTUBE_SAVE_VIDEO", True)
    youtube_max_video_height: int = int(os.environ.get("YOUTUBE_MAX_VIDEO_HEIGHT", "1080"))
    youtube_download_captions: bool = _env_bool("YOUTUBE_DOWNLOAD_CAPTIONS", False)
    # Netscape cookies.txt for yt-dlp (required when YouTube bot-checks the container IP).
    youtube_cookies_file: Path | None = (
        Path(os.environ["YOUTUBE_COOKIES_FILE"])
        if os.environ.get("YOUTUBE_COOKIES_FILE", "").strip()
        else None
    )
    adtof_device: str = os.environ.get("ADTOF_DEVICE", os.environ.get("DEMUCS_DEVICE", "cpu"))
    align_device: str = os.environ.get("ALIGN_DEVICE", os.environ.get("DEMUCS_DEVICE", "cpu"))
    whisper_model: str = os.environ.get("WHISPER_MODEL", "small")
    # Empty = auto (float16 on cuda, int8 on cpu).
    whisper_compute_type: str = os.environ.get("WHISPER_COMPUTE_TYPE", "").strip()


settings = Settings()
