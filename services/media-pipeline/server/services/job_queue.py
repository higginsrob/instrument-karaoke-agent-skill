from __future__ import annotations

import json
import logging
import shutil
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from server.config import settings
from server.services.demucs_runner import run_demucs
from server.services.drums import process_drums
from server.services.export_video import run_export_video
from server.services.force_align import align_chart_to_vtt
from server.services.media_paths import media_dir_for_song, normalize_song_path, song_md_path, write_media_json
from server.services.mix_renderer import MIX_DEFINITIONS, render_karaoke_mixes
from server.services.song_meta import update_song_media_fields
from server.services.youtube import YouTubeService

logger = logging.getLogger(__name__)

TERMINAL_STATUSES = frozenset({"needs_review", "completed", "failed", "cancelled"})


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class JobRecord:
    id: str
    song_path: str
    youtube_url: str = ""
    chart_body: str = ""
    title: Optional[str] = None
    artist: Optional[str] = None
    job_type: str = "process_song"
    status: str = "queued"
    progress: int = 0
    stage: Optional[str] = None
    message: Optional[str] = None
    error_message: Optional[str] = None
    media_dir: Optional[str] = None
    output_file: Optional[str] = None
    muted: dict[str, bool] = field(default_factory=dict)
    soloed: dict[str, bool] = field(default_factory=dict)
    mix: str = "original"
    width: int = 1920
    height: int = 1080
    fps: Optional[float] = None
    created_at: str = field(default_factory=_utc_now)
    started_at: Optional[str] = None
    completed_at: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "JobRecord":
        known = {f.name for f in cls.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        cleaned = {k: v for k, v in data.items() if k in known}
        if "muted" in cleaned and cleaned["muted"] is None:
            cleaned["muted"] = {}
        if "soloed" in cleaned and cleaned["soloed"] is None:
            cleaned["soloed"] = {}
        if "mix" in cleaned and cleaned["mix"] is None:
            cleaned["mix"] = "original"
        return cls(**cleaned)


class JobQueue:
    def __init__(self) -> None:
        self.jobs_dir = settings.jobs_dir
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.youtube = YouTubeService()
        self.jobs: dict[str, JobRecord] = {}
        self.queue: list[str] = []
        self.lock = threading.Lock()
        self.processing_lock = threading.Lock()
        self.currently_processing: Optional[str] = None
        self.cancel_requested = threading.Event()
        self.paused = False
        self._pending_purge: set[str] = set()
        self._load_jobs()
        self._worker = threading.Thread(target=self._worker_loop, name="media-worker", daemon=True)
        self._worker.start()

    def _meta_path(self, job_id: str) -> Path:
        return self.jobs_dir / job_id / "job.json"

    def _save(self, job: JobRecord) -> None:
        path = self._meta_path(job.id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(job.to_dict(), indent=2), encoding="utf-8")

    def _remove_job_files(self, job_id: str) -> None:
        path = self.jobs_dir / job_id
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)

    def _delete_job_unlocked(self, job_id: str) -> None:
        self.jobs.pop(job_id, None)
        if job_id in self.queue:
            self.queue.remove(job_id)
        self._pending_purge.discard(job_id)

    def _load_jobs(self) -> None:
        for meta_path in self.jobs_dir.glob("*/job.json"):
            try:
                data = json.loads(meta_path.read_text(encoding="utf-8"))
                job = JobRecord.from_dict(data)
                if job.status == "processing":
                    job.status = "queued"
                    job.progress = 0
                    job.message = "Re-queued after restart"
                    job.started_at = None
                    job.error_message = None
                    self._save(job)
                self.jobs[job.id] = job
                if job.status == "queued":
                    self.queue.append(job.id)
            except Exception as exc:
                logger.warning("Skipping invalid job %s: %s", meta_path, exc)

    def pause(self) -> None:
        with self.lock:
            self.paused = True

    def resume(self) -> None:
        with self.lock:
            self.paused = False

    def is_paused(self) -> bool:
        with self.lock:
            return self.paused

    def get_job(self, job_id: str) -> Optional[JobRecord]:
        with self.lock:
            return self.jobs.get(job_id)

    def queue_position(self, job_id: str) -> Optional[int]:
        with self.lock:
            try:
                return self.queue.index(job_id) + 1
            except ValueError:
                return None

    def list_jobs(self, *, limit: int = 50) -> list[JobRecord]:
        with self.lock:
            jobs = list(self.jobs.values())
            queue_order = {jid: i for i, jid in enumerate(self.queue)}
        rank = {"processing": 0, "queued": 1, "failed": 2, "cancelled": 3, "needs_review": 4, "completed": 5}

        def sort_key(job: JobRecord) -> tuple:
            ts = job.completed_at or job.started_at or job.created_at
            try:
                t = datetime.fromisoformat(ts).timestamp()
            except (TypeError, ValueError):
                t = 0.0
            return (rank.get(job.status, 9), queue_order.get(job.id, 9999), -t)

        jobs.sort(key=sort_key)
        return jobs[: max(1, limit)]

    def submit(
        self,
        *,
        song_path: str,
        youtube_url: str = "",
        chart_body: str = "",
        title: Optional[str] = None,
        artist: Optional[str] = None,
        job_type: str = "process_song",
        muted: Optional[dict[str, bool]] = None,
        soloed: Optional[dict[str, bool]] = None,
        mix: Optional[str] = None,
        width: int = 1920,
        height: int = 1080,
        fps: Optional[float] = None,
    ) -> JobRecord:
        if job_type == "process_song":
            if not self.youtube.is_youtube_url(youtube_url or ""):
                raise ValueError("Invalid YouTube URL")
        elif job_type != "export_video":
            raise ValueError(f"Unsupported job_type: {job_type}")

        rel = normalize_song_path(song_path)
        media_dir = media_dir_for_song(rel)
        mix_id = (mix or "original").strip() or "original"
        if job_type == "export_video":
            video_path = media_dir / "youtube" / "video.mp4"
            if not video_path.is_file():
                raise ValueError("Missing youtube/video.mp4 — process the song before exporting")
            if mix_id not in MIX_DEFINITIONS:
                raise ValueError(f"Unsupported mix: {mix_id}")

        # Reuse an in-flight export instead of stacking a second silent queue entry.
        if job_type == "export_video":
            with self.lock:
                for existing in self.jobs.values():
                    if (
                        existing.song_path == rel
                        and existing.job_type == "export_video"
                        and existing.status in ("queued", "processing")
                    ):
                        return existing

        job_id = uuid.uuid4().hex[:12]
        try:
            media_rel = str(media_dir.relative_to(settings.library_dir))
        except ValueError:
            media_rel = str(media_dir)
        job = JobRecord(
            id=job_id,
            song_path=rel,
            youtube_url=(youtube_url or "").strip(),
            chart_body=chart_body or "",
            title=title,
            artist=artist,
            job_type=job_type,
            media_dir=media_rel,
            muted=dict(muted or {}),
            soloed=dict(soloed or {}),
            mix=mix_id,
            width=int(width),
            height=int(height),
            fps=fps,
        )
        with self.lock:
            # Supersede only same (song_path, job_type) queued jobs
            for existing in list(self.jobs.values()):
                if (
                    existing.song_path == rel
                    and existing.job_type == job_type
                    and existing.status == "queued"
                ):
                    existing.status = "cancelled"
                    existing.completed_at = _utc_now()
                    existing.message = "Superseded by newer job"
                    if existing.id in self.queue:
                        self.queue.remove(existing.id)
                    self._save(existing)
            self.jobs[job.id] = job
            self.queue.append(job.id)
        self._save(job)

        if job_type == "process_song":
            write_media_json(
                media_dir,
                {
                    "job_id": job.id,
                    "status": "queued",
                    "youtube_url": job.youtube_url,
                    "song_path": rel,
                    "updated_at": _utc_now(),
                },
            )
            try:
                update_song_media_fields(
                    song_md_path(rel),
                    media_status="queued",
                    youtube_url=job.youtube_url,
                )
            except Exception:
                logger.exception("Failed to mark song queued in frontmatter")
        elif job_type == "export_video":
            self._write_export_status(job)
        return job

    def cancel_job(self, job_id: str) -> bool:
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return False
            if job.status == "queued":
                if job_id in self.queue:
                    self.queue.remove(job_id)
                job.status = "cancelled"
                job.completed_at = _utc_now()
                self._save(job)
                return True
            if job.status == "processing":
                job.status = "cancelled"
                self._save(job)
                self.cancel_requested.set()
                return True
            return False

    def clear_completed(self) -> int:
        """Remove finished jobs (needs_review, completed, failed, cancelled)."""
        with self.lock:
            remove_ids = [jid for jid, job in self.jobs.items() if job.status in TERMINAL_STATUSES]
            for jid in remove_ids:
                self._delete_job_unlocked(jid)
        for jid in remove_ids:
            self._remove_job_files(jid)
        return len(remove_ids)

    def clear_all(self) -> int:
        """Cancel active work and remove every job from the queue."""
        with self.lock:
            processing_id = None
            for jid, job in self.jobs.items():
                if job.status == "processing":
                    processing_id = jid
                    job.status = "cancelled"
                    job.message = "Cleared"
                    job.completed_at = _utc_now()
                    self.cancel_requested.set()
                    self._pending_purge.add(jid)
                    break

            remove_ids = [jid for jid in list(self.jobs.keys()) if jid != processing_id]
            for jid in remove_ids:
                self._delete_job_unlocked(jid)
            self.queue.clear()
            count = len(remove_ids) + (1 if processing_id else 0)
        for jid in remove_ids:
            self._remove_job_files(jid)
        return count

    def _update(self, job: JobRecord, *, save: bool = True) -> None:
        with self.lock:
            # Do not resurrect jobs that were hard-deleted from the queue.
            if job.id not in self.jobs and job.id not in self._pending_purge:
                return
            self.jobs[job.id] = job
        if save:
            self._save(job)

    def _report(self, job: JobRecord, progress: int, stage: str, message: str) -> None:
        job.progress = progress
        job.stage = stage
        job.message = message
        self._update(job)
        if job.job_type == "export_video":
            self._write_export_status(job)
            return
        if job.job_type != "process_song":
            return
        if job.media_dir:
            try:
                media_dir = settings.library_dir / job.media_dir
                write_media_json(
                    media_dir,
                    {
                        "job_id": job.id,
                        "status": job.status,
                        "youtube_url": job.youtube_url,
                        "song_path": job.song_path,
                        "stage": stage,
                        "progress": progress,
                        "message": message,
                        "updated_at": _utc_now(),
                    },
                )
            except Exception:
                logger.exception("Failed to write media.json for %s", job.id)

    def _write_export_status(self, job: JobRecord) -> None:
        """Sidecar the frontend can read without depending only on the job queue API."""
        if not job.media_dir:
            return
        try:
            media_dir = settings.library_dir / job.media_dir
            exports_dir = media_dir / "exports"
            exports_dir.mkdir(parents=True, exist_ok=True)
            payload = {
                "job_id": job.id,
                "job_type": "export_video",
                "status": job.status,
                "progress": job.progress,
                "stage": job.stage,
                "message": job.message,
                "error_message": job.error_message,
                "output_file": job.output_file,
                "width": job.width,
                "height": job.height,
                "fps": job.fps,
                "updated_at": _utc_now(),
            }
            (exports_dir / "status.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except Exception:
            logger.exception("Failed to write exports/status.json for %s", job.id)

    def _worker_loop(self) -> None:
        while True:
            try:
                if self.is_paused():
                    time.sleep(0.5)
                    continue
                with self.processing_lock:
                    busy = self.currently_processing is not None
                if busy:
                    time.sleep(0.5)
                    continue
                next_id = None
                with self.lock:
                    for job_id in self.queue:
                        job = self.jobs.get(job_id)
                        if job and job.status == "queued":
                            next_id = job_id
                            break
                if not next_id:
                    time.sleep(0.5)
                    continue
                self._process_job(next_id)
            except Exception:
                logger.exception("Worker loop error")
                time.sleep(1)

    def _process_job(self, job_id: str) -> None:
        job = self.get_job(job_id)
        if not job or job.status != "queued":
            return
        with self.processing_lock:
            if self.currently_processing is not None:
                return
            self.currently_processing = job_id

        self.cancel_requested.clear()
        job.status = "processing"
        job.started_at = _utc_now()
        self._update(job)
        self._report(job, 1, "starting", "Starting job")

        try:
            if job.job_type == "export_video":
                self._process_export_job(job)
            else:
                self._process_song_job(job)
        except Exception as exc:
            logger.exception("Job %s failed", job_id)
            current = self.get_job(job_id)
            if current and current.status == "cancelled":
                current.message = "Cancelled"
                current.completed_at = _utc_now()
                self._update(current)
            else:
                job.status = "failed"
                job.error_message = str(exc)
                job.message = str(exc)
                job.completed_at = _utc_now()
                self._update(job)
                if job.job_type == "export_video":
                    self._write_export_status(job)
                elif job.job_type == "process_song":
                    try:
                        media_dir = media_dir_for_song(job.song_path)
                        write_media_json(
                            media_dir,
                            {
                                "job_id": job.id,
                                "status": "failed",
                                "youtube_url": job.youtube_url,
                                "song_path": job.song_path,
                                "error": str(exc),
                                "updated_at": _utc_now(),
                            },
                        )
                        update_song_media_fields(
                            song_md_path(job.song_path),
                            media_status="failed",
                            youtube_url=job.youtube_url,
                        )
                    except Exception:
                        pass
        finally:
            purge = False
            with self.lock:
                if job_id in self.queue:
                    self.queue.remove(job_id)
                if job_id in self._pending_purge:
                    self._pending_purge.discard(job_id)
                    self.jobs.pop(job_id, None)
                    purge = True
            if purge:
                self._remove_job_files(job_id)
            with self.processing_lock:
                if self.currently_processing == job_id:
                    self.currently_processing = None

    def _process_export_job(self, job: JobRecord) -> None:
        media_dir = media_dir_for_song(job.song_path)
        media_dir.mkdir(parents=True, exist_ok=True)
        job.media_dir = str(media_dir.relative_to(settings.library_dir))
        self._update(job)

        def should_cancel() -> bool:
            if self.cancel_requested.is_set():
                return True
            current = self.get_job(job.id)
            return bool(current and current.status == "cancelled")

        def on_progress(progress: int, stage: str, message: str) -> None:
            if should_cancel():
                raise RuntimeError("Job was cancelled")
            self._report(job, progress, stage, message)

        output_rel = run_export_video(
            media_dir=media_dir,
            job_id=job.id,
            mix=job.mix or "original",
            muted=job.muted,
            soloed=job.soloed,
            width=job.width,
            height=job.height,
            fps=job.fps,
            chart_body=job.chart_body or "",
            lyric_display="chart",
            on_progress=on_progress,
            should_cancel=should_cancel,
        )
        if should_cancel():
            raise RuntimeError("Job was cancelled")

        job.status = "completed"
        job.progress = 100
        job.stage = "completed"
        job.message = "Export ready"
        job.output_file = output_rel
        job.completed_at = _utc_now()
        self._update(job)
        self._write_export_status(job)

    def _process_song_job(self, job: JobRecord) -> None:
        try:
            update_song_media_fields(
                song_md_path(job.song_path),
                media_status="processing",
                youtube_url=job.youtube_url,
            )
        except Exception:
            logger.exception("Failed to mark song processing in frontmatter")

        media_dir = media_dir_for_song(job.song_path)
        media_dir.mkdir(parents=True, exist_ok=True)
        job.media_dir = str(media_dir.relative_to(settings.library_dir))
        self._update(job)

        def should_cancel() -> bool:
            if self.cancel_requested.is_set():
                return True
            current = self.get_job(job.id)
            return bool(current and current.status == "cancelled")

        # 1) YouTube
        self._report(job, 5, "youtube", "Downloading YouTube audio/video")
        if should_cancel():
            raise RuntimeError("Job was cancelled")
        audio_path, yt_meta = self.youtube.download_for_song(job.youtube_url, media_dir)
        self._report(job, 30, "youtube", f"Downloaded: {yt_meta.title}")

        # 2) Demucs
        if should_cancel():
            raise RuntimeError("Job was cancelled")
        stems_dir = media_dir / "stems"
        run_demucs(
            input_file=audio_path,
            stems_dir=stems_dir,
            on_progress=lambda p, m: self._report(job, p, "demucs", m),
            should_cancel=should_cancel,
        )

        # 3) Pre-render karaoke mixes
        if should_cancel():
            raise RuntimeError("Job was cancelled")
        mix_names = render_karaoke_mixes(
            media_dir=media_dir,
            source_mp3=audio_path,
            stems_dir=stems_dir,
            on_progress=lambda p, m: self._report(job, p, "mixes", m),
            should_cancel=should_cancel,
        )

        # 4) Force-align (STT on vocals → join to chart; energy fallback)
        if should_cancel():
            raise RuntimeError("Job was cancelled")
        self._report(job, 78, "align", "Aligning lyrics to vocals (STT)")
        vocals = stems_dir / "vocals.wav"
        align_info = align_chart_to_vtt(
            chart_body=job.chart_body,
            vocals_path=vocals,
            lyrics_vtt_path=media_dir / "lyrics.vtt",
            chords_vtt_path=media_dir / "chords.vtt",
            device=settings.align_device if settings.align_device in ("cpu", "cuda") else "cpu",
            stt_hypothesis_vtt_path=media_dir / "stt_hypothesis.vtt",
        )
        logger.info(
            "Align finished method=%s lyrics=%s chords=%s",
            align_info.get("method"),
            align_info.get("lyrics_cues"),
            align_info.get("chords_cues"),
        )

        # 5) Drums
        if should_cancel():
            raise RuntimeError("Job was cancelled")
        self._report(job, 90, "drums", "Transcribing drums to MIDI")
        drums_wav = stems_dir / "drums.wav"
        drum_info = process_drums(drums_wav, media_dir)

        job.status = "needs_review"
        job.progress = 100
        job.stage = "needs_review"
        job.message = f"Ready for review ({drum_info.get('onsets', 0)} drum hits)"
        job.completed_at = _utc_now()
        self._update(job)
        write_media_json(
            media_dir,
            {
                "job_id": job.id,
                "status": "needs_review",
                "youtube_url": job.youtube_url,
                "song_path": job.song_path,
                "title": yt_meta.title,
                "stems": sorted(p.name for p in (media_dir / "stems").glob("*.wav")),
                "mixes": mix_names,
                "lyrics_vtt": "lyrics.vtt",
                "chords_vtt": "chords.vtt",
                "align_method": align_info.get("method"),
                **(
                    {"stt_hypothesis": align_info["stt_hypothesis"]}
                    if align_info.get("stt_hypothesis")
                    else {}
                ),
                "drums_beats": "drums_beats.json",
                "drums_midi": "drums.mid",
                "youtube": yt_meta.to_dict(),
                "updated_at": _utc_now(),
            },
        )
        try:
            update_song_media_fields(
                song_md_path(job.song_path),
                media_status="needs_review",
                youtube_url=job.youtube_url,
            )
        except Exception:
            logger.exception("Failed to update song frontmatter after success")


job_queue = JobQueue()
