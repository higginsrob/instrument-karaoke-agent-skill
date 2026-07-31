"""Offline video export: karaoke mix + overlay burn-in via ffmpeg + Pillow."""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
from concurrent.futures import Future, ThreadPoolExecutor, wait, FIRST_COMPLETED
from pathlib import Path
from typing import Any, Callable, Optional

from server.services.export_overlays import Cue, OverlayRenderer, load_cues, load_drums
from server.services.mix_renderer import (
    MIX_DEFINITIONS,
    mix_stems_to_mp3,
    resolve_mix_path,
)

logger = logging.getLogger(__name__)

STEM_NAMES = ["vocals", "drums", "bass", "other"]
ProgressCb = Callable[[int, str, str], None]
CancelCb = Callable[[], bool]


def audible_stems(
    stems_dir: Path,
    muted: dict[str, bool],
    soloed: dict[str, bool],
) -> list[Path]:
    """Legacy mute/solo helper kept for tests and fallback export."""
    available = [name for name in STEM_NAMES if (stems_dir / f"{name}.wav").is_file()]
    any_solo = any(soloed.get(name) for name in available)
    out: list[Path] = []
    for name in available:
        if muted.get(name):
            continue
        if any_solo and not soloed.get(name):
            continue
        out.append(stems_dir / f"{name}.wav")
    return out


def _ffprobe_json(path: Path) -> dict:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=avg_frame_rate,width,height,codec_type",
        "-of",
        "json",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "ffprobe failed")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("ffprobe returned invalid JSON") from exc


def probe_video(path: Path) -> tuple[float, float, int, int]:
    data = _ffprobe_json(path)
    duration = float((data.get("format") or {}).get("duration") or 0)
    fps = 30.0
    width = 0
    height = 0
    for stream in data.get("streams") or []:
        if stream.get("codec_type") != "video":
            continue
        width = int(stream.get("width") or 0)
        height = int(stream.get("height") or 0)
        rate = str(stream.get("avg_frame_rate") or "0/1")
        if "/" in rate:
            num_s, den_s = rate.split("/", 1)
            try:
                num, den = float(num_s), float(den_s)
                if den > 0 and num > 0:
                    fps = num / den
            except ValueError:
                pass
        break
    if duration <= 0:
        raise RuntimeError("Could not determine video duration")
    if fps < 1:
        fps = 30.0
    return duration, fps, width, height


def resolve_export_audio(
    *,
    media_dir: Path,
    mix_id: str,
    duration: float,
    tmp_dir: Path,
) -> Path:
    """Return a stereo audio file for export (pre-rendered mix preferred)."""
    mix_id = mix_id if mix_id in MIX_DEFINITIONS else "original"
    pre = resolve_mix_path(media_dir, mix_id)
    if pre.is_file():
        return pre

    # Fallback: build from stems (or source for original).
    if mix_id == "original":
        source = media_dir / "source.mp3"
        if source.is_file():
            return source
        raise RuntimeError("Missing mixes/original.mp3 and source.mp3")

    stem_set = MIX_DEFINITIONS[mix_id]
    assert stem_set is not None
    stems_dir = media_dir / "stems"
    stem_paths = [stems_dir / f"{name}.wav" for name in stem_set]
    missing = [p.name for p in stem_paths if not p.is_file()]
    if missing:
        raise RuntimeError(f"Missing stems for mix {mix_id}: {', '.join(missing)}")
    out = tmp_dir / f"{mix_id}.mp3"
    mix_stems_to_mp3(stem_paths, out, duration)
    return out


def _stream_overlays_to_ffmpeg(
    *,
    proc: subprocess.Popen,
    n_frames: int,
    width: int,
    height: int,
    target_fps: float,
    duration: float,
    lyrics_cues: list[Cue],
    chords_cues: list[Cue],
    drums_beats: dict[str, Any],
    drums_silent: bool,
    chart_body: str = "",
    lyric_display: str = "chart",
    on_progress: Optional[ProgressCb],
    should_cancel: Optional[CancelCb],
) -> None:
    """Render overlay frames in parallel, write in-order to ffmpeg stdin.

    Not HTTP — all local. A bounded thread pool pre-renders ahead while the
    main thread streams RGBA into ffmpeg (avoids a multi‑GB raw tempfile).
    """
    assert proc.stdin is not None
    workers = max(1, min(6, (os.cpu_count() or 2)))
    max_inflight = workers * 3
    tls = threading.local()

    def renderer_for_thread() -> OverlayRenderer:
        r = getattr(tls, "renderer", None)
        if r is None:
            r = OverlayRenderer(width, height, lyric_display=lyric_display)
            r.prepare(
                lyrics_cues,
                chords_cues,
                drums_beats,
                drums_silent,
                chart_body=chart_body,
            )
            tls.renderer = r
        return r

    def render_index(i: int) -> bytes:
        return renderer_for_thread().render_frame(
            current_time=i / target_fps,
            duration=duration,
        ).tobytes("raw", "RGBA")

    report_every = max(1, n_frames // 50)
    next_write = 0
    ready: dict[int, bytes] = {}
    inflight: dict[Future[bytes], int] = {}
    submitted = 0

    with ThreadPoolExecutor(max_workers=workers) as pool:
        while next_write < n_frames:
            if should_cancel and should_cancel():
                raise RuntimeError("Job was cancelled")

            while submitted < n_frames and len(inflight) < max_inflight:
                fut = pool.submit(render_index, submitted)
                inflight[fut] = submitted
                submitted += 1

            if not inflight:
                break

            done, _ = wait(tuple(inflight.keys()), return_when=FIRST_COMPLETED)
            for fut in done:
                idx = inflight.pop(fut)
                ready[idx] = fut.result()

            while next_write in ready:
                proc.stdin.write(ready.pop(next_write))
                if next_write % report_every == 0 and on_progress:
                    pct = 18 + int(62 * (next_write / max(1, n_frames - 1)))
                    on_progress(
                        pct,
                        "encode",
                        f"Rendering/encoding frame {next_write + 1}/{n_frames}",
                    )
                next_write += 1

    proc.stdin.close()


def run_export_video(
    *,
    media_dir: Path,
    job_id: str,
    mix: str = "original",
    muted: Optional[dict[str, bool]] = None,
    soloed: Optional[dict[str, bool]] = None,
    width: int,
    height: int,
    fps: Optional[float],
    chart_body: str = "",
    lyric_display: str = "chart",
    on_progress: Optional[ProgressCb] = None,
    should_cancel: Optional[CancelCb] = None,
) -> str:
    """Render export MP4. Returns media-dir-relative path e.g. exports/export-<id>.mp4."""

    def progress(p: int, stage: str, message: str) -> None:
        if on_progress:
            on_progress(p, stage, message)

    def cancelled() -> bool:
        return bool(should_cancel and should_cancel())

    video_path = media_dir / "youtube" / "video.mp4"
    if not video_path.is_file():
        raise RuntimeError("Missing youtube/video.mp4")

    mix_id = mix if mix in MIX_DEFINITIONS else "original"
    lyrics_cues = load_cues(media_dir / "lyrics.vtt")
    chords_cues = load_cues(media_dir / "chords.vtt")
    drums_beats = load_drums(media_dir / "drums_beats.json")
    # Always burn drums at full opacity — mix choice only affects audio.
    # (Live preview dims the lane when drums are muted; exports stay readable.)
    display = "chart"

    duration, source_fps, _sw, _sh = probe_video(video_path)
    target_fps = float(fps) if fps and fps > 0 else float(source_fps)
    target_fps = max(1.0, min(60.0, target_fps))
    width = int(width)
    height = int(height)

    exports_dir = media_dir / "exports"
    exports_dir.mkdir(parents=True, exist_ok=True)
    output_rel = f"exports/export-{job_id}.mp4"
    output_path = media_dir / output_rel

    with tempfile.TemporaryDirectory(prefix=f"export-{job_id}-") as tmp:
        tmp_dir = Path(tmp)

        progress(5, "mix_audio", f"Preparing audio mix ({mix_id})")
        if cancelled():
            raise RuntimeError("Job was cancelled")
        audio_path = resolve_export_audio(
            media_dir=media_dir,
            mix_id=mix_id,
            duration=duration,
            tmp_dir=tmp_dir,
        )
        # Copy into tmp if needed so ffmpeg always reads a stable path.
        if audio_path.parent != tmp_dir:
            mixed_audio = tmp_dir / audio_path.name
            shutil.copy2(audio_path, mixed_audio)
        else:
            mixed_audio = audio_path

        n_frames = max(1, int(round(duration * target_fps)))
        progress(15, "encode", f"Rendering {n_frames} overlay frames (parallel)")
        if cancelled():
            raise RuntimeError("Job was cancelled")

        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(video_path),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-s",
            f"{width}x{height}",
            "-r",
            f"{target_fps:.6f}",
            "-i",
            "pipe:0",
            "-i",
            str(mixed_audio),
            # Match live player: 16:9 cover + ~55% video opacity over #12151a.
            "-filter_complex",
            (
                f"color=c=0x12151A:s={width}x{height}:r={target_fps:.6f},format=rgba[bg];"
                f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                f"crop={width}:{height},fps={target_fps:.6f},setsar=1,format=rgba,"
                f"colorchannelmixer=aa=0.55[vid];"
                f"[bg][vid]overlay=0:0:format=auto[base];"
                f"[base][1:v]overlay=0:0:format=auto,format=yuv420p[outv]"
            ),
            "-map",
            "[outv]",
            "-map",
            "2:a",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        stderr_chunks: list[bytes] = []

        def _drain_stderr() -> None:
            if not proc.stderr:
                return
            while True:
                chunk = proc.stderr.read(4096)
                if not chunk:
                    break
                stderr_chunks.append(chunk)

        drain = threading.Thread(target=_drain_stderr, daemon=True)
        drain.start()
        try:
            _stream_overlays_to_ffmpeg(
                proc=proc,
                n_frames=n_frames,
                width=width,
                height=height,
                target_fps=target_fps,
                duration=duration,
                lyrics_cues=lyrics_cues,
                chords_cues=chords_cues,
                drums_beats=drums_beats,
                drums_silent=False,
                chart_body=chart_body or "",
                lyric_display=display,
                on_progress=on_progress,
                should_cancel=should_cancel,
            )
            code = proc.wait()
            drain.join(timeout=5)
            stderr = b"".join(stderr_chunks).decode("utf-8", errors="replace")
            if code != 0:
                raise RuntimeError(stderr.strip() or f"ffmpeg encode failed ({code})")
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
            drain.join(timeout=2)
            if output_path.is_file():
                output_path.unlink(missing_ok=True)
            raise

    if not output_path.is_file():
        raise RuntimeError("Export finished but output file missing")

    sidecar = exports_dir / f"export-{job_id}.json"
    sidecar.write_text(
        json.dumps(
            {
                "job_id": job_id,
                "output_file": output_rel,
                "width": width,
                "height": height,
                "fps": target_fps,
                "mix": mix_id,
                "muted": muted or {},
                "soloed": soloed or {},
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    progress(100, "completed", "Export ready")
    return output_rel
