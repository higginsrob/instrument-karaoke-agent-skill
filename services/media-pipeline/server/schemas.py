from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, model_validator


class JobCreateRequest(BaseModel):
    job_type: Literal["process_song", "export_video"] = "process_song"
    song_path: str = Field(..., description="Library-relative path, e.g. artists/a/albums/b/c.md")
    youtube_url: Optional[str] = None
    chart_body: str = ""
    title: Optional[str] = None
    artist: Optional[str] = None
    # export_video fields
    mix: str = "original"
    muted: dict[str, bool] = Field(default_factory=dict)
    soloed: dict[str, bool] = Field(default_factory=dict)
    width: int = 1920
    height: int = 1080
    fps: Optional[float] = None
    show_drums: bool = True

    @model_validator(mode="after")
    def validate_by_job_type(self) -> "JobCreateRequest":
        if self.job_type == "process_song":
            if not (self.youtube_url or "").strip():
                raise ValueError("youtube_url is required for process_song jobs")
        if self.job_type == "export_video":
            if self.width < 160 or self.height < 90:
                raise ValueError("width/height too small")
            if self.width > 3840 or self.height > 2160:
                raise ValueError("width/height too large")
            if self.fps is not None and (self.fps < 1 or self.fps > 60):
                raise ValueError("fps must be between 1 and 60, or null for source")
            allowed = {
                "original",
                "karaoke-vocals",
                "karaoke-bass",
                "karaoke-other",
                "karaoke-drums",
            }
            if self.mix not in allowed:
                raise ValueError(f"mix must be one of: {', '.join(sorted(allowed))}")
        return self


class JobRecordOut(BaseModel):
    id: str
    status: str
    job_type: str = "process_song"
    song_path: str
    youtube_url: Optional[str] = None
    title: Optional[str] = None
    artist: Optional[str] = None
    progress: int = 0
    stage: Optional[str] = None
    message: Optional[str] = None
    error_message: Optional[str] = None
    queue_position: Optional[int] = None
    created_at: Optional[datetime] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    media_dir: Optional[str] = None
    output_file: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    fps: Optional[float] = None


class JobListResponse(BaseModel):
    jobs: list[JobRecordOut]
    paused: bool = False


class QueueControlResponse(BaseModel):
    ok: bool
    paused: bool


class QueueClearResponse(BaseModel):
    ok: bool
    removed: int
    paused: bool


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    device: str
    cuda: bool
    library_dir: str
    model: str
    youtube_cookies: bool = False


def error_body(message: str, error_type: str = "invalid_request") -> dict[str, Any]:
    return {"error": {"message": message, "type": error_type}}
