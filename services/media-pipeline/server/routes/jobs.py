from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from server.schemas import (
    JobCreateRequest,
    JobListResponse,
    JobRecordOut,
    QueueClearResponse,
    QueueControlResponse,
    error_body,
)
from server.services.job_queue import JobRecord, job_queue

router = APIRouter(tags=["jobs"])


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _to_out(job: JobRecord) -> JobRecordOut:
    return JobRecordOut(
        id=job.id,
        status=job.status,
        job_type=job.job_type or "process_song",
        song_path=job.song_path,
        youtube_url=job.youtube_url or None,
        title=job.title,
        artist=job.artist,
        progress=job.progress,
        stage=job.stage,
        message=job.message,
        error_message=job.error_message,
        queue_position=job_queue.queue_position(job.id) if job.status == "queued" else None,
        created_at=_parse_dt(job.created_at),
        started_at=_parse_dt(job.started_at),
        completed_at=_parse_dt(job.completed_at),
        media_dir=job.media_dir,
        output_file=job.output_file,
        width=job.width if job.job_type == "export_video" else None,
        height=job.height if job.job_type == "export_video" else None,
        fps=job.fps if job.job_type == "export_video" else None,
    )


@router.post("/v1/jobs")
def create_job(body: JobCreateRequest):
    try:
        job = job_queue.submit(
            song_path=body.song_path,
            youtube_url=body.youtube_url or "",
            chart_body=body.chart_body or "",
            title=body.title,
            artist=body.artist,
            job_type=body.job_type,
            muted=body.muted,
            soloed=body.soloed,
            mix=body.mix,
            width=body.width,
            height=body.height,
            fps=body.fps,
            show_drums=body.show_drums,
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content=error_body(str(exc)))
    except Exception as exc:
        return JSONResponse(status_code=500, content=error_body(str(exc), "server_error"))
    return _to_out(job)


@router.get("/v1/jobs", response_model=JobListResponse)
def list_jobs(limit: int = Query(50, ge=1, le=200)) -> JobListResponse:
    jobs = [_to_out(j) for j in job_queue.list_jobs(limit=limit)]
    return JobListResponse(jobs=jobs, paused=job_queue.is_paused())


@router.get("/v1/jobs/{job_id}", response_model=JobRecordOut)
def get_job(job_id: str) -> JobRecordOut:
    job = job_queue.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _to_out(job)


@router.delete("/v1/jobs/{job_id}")
def cancel_job(job_id: str):
    ok = job_queue.cancel_job(job_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Job not found or not cancellable")
    job = job_queue.get_job(job_id)
    return _to_out(job) if job else {"ok": True}


@router.post("/v1/queue/pause", response_model=QueueControlResponse)
def pause_queue() -> QueueControlResponse:
    job_queue.pause()
    return QueueControlResponse(ok=True, paused=True)


@router.post("/v1/queue/resume", response_model=QueueControlResponse)
def resume_queue() -> QueueControlResponse:
    job_queue.resume()
    return QueueControlResponse(ok=True, paused=False)


@router.post("/v1/queue/clear-complete", response_model=QueueClearResponse)
def clear_complete() -> QueueClearResponse:
    removed = job_queue.clear_completed()
    return QueueClearResponse(ok=True, removed=removed, paused=job_queue.is_paused())


@router.post("/v1/queue/clear", response_model=QueueClearResponse)
def clear_queue() -> QueueClearResponse:
    removed = job_queue.clear_all()
    return QueueClearResponse(ok=True, removed=removed, paused=job_queue.is_paused())
