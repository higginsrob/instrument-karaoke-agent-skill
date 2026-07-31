"""Pre-render karaoke stereo mixes from htdemucs stems."""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[int, str], None]
CancelCallback = Callable[[], bool]

STEM_NAMES = ("vocals", "drums", "bass", "other")
# Preferred display order when discovering demucs 4-stem / 6-stem outputs.
STEM_DISCOVERY_ORDER = ("vocals", "drums", "bass", "guitar", "piano", "other")

# Mix id → stems included (None means copy source.mp3 as the original full mix).
MIX_DEFINITIONS: dict[str, Optional[tuple[str, ...]]] = {
    "original": None,
    "karaoke-vocals": ("drums", "bass", "other"),
    "karaoke-bass": ("vocals", "drums", "other"),
    "karaoke-other": ("vocals", "drums", "bass"),
    "karaoke-drums": ("vocals", "bass", "other"),
}


def discover_stem_names(stems_dir: Path) -> list[str]:
    """Return stem basenames that have a .wav on disk (known order first)."""
    if not stems_dir.is_dir():
        return []
    found = {p.stem for p in stems_dir.glob("*.wav") if p.is_file()}
    ordered = [name for name in STEM_DISCOVERY_ORDER if name in found]
    extras = sorted(name for name in found if name not in STEM_DISCOVERY_ORDER)
    return ordered + extras


def stem_mix_id(stem_name: str) -> str:
    return f"stem-{stem_name}"

MIX_BITRATE = "192k"


def mix_file_name(mix_id: str) -> str:
    return f"{mix_id}.mp3"


def resolve_mix_path(media_dir: Path, mix_id: str) -> Path:
    return media_dir / "mixes" / mix_file_name(mix_id)


def drums_silent_for_mix(mix_id: str) -> bool:
    return mix_id == "karaoke-drums"


def _probe_duration(path: Path) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "ffprobe failed")
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("ffprobe returned invalid JSON") from exc
    duration = float((data.get("format") or {}).get("duration") or 0)
    if duration <= 0:
        raise RuntimeError(f"Could not determine duration for {path.name}")
    return duration


def _encode_original(source_mp3: Path, output_mp3: Path) -> None:
    output_mp3.parent.mkdir(parents=True, exist_ok=True)
    # Prefer a straight copy when already MP3; fall back to re-encode.
    if source_mp3.suffix.lower() == ".mp3":
        shutil.copy2(source_mp3, output_mp3)
        return
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(source_mp3),
        "-vn",
        "-ac",
        "2",
        "-ar",
        "44100",
        "-c:a",
        "libmp3lame",
        "-b:a",
        MIX_BITRATE,
        str(output_mp3),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Failed to encode original mix")


def mix_stems_to_mp3(
    stem_paths: list[Path],
    output_mp3: Path,
    duration: float,
) -> Path:
    output_mp3.parent.mkdir(parents=True, exist_ok=True)
    if not stem_paths:
        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-t",
            f"{duration:.3f}",
            "-c:a",
            "libmp3lame",
            "-b:a",
            MIX_BITRATE,
            str(output_mp3),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "Failed to create silent mix")
        return output_mp3

    if len(stem_paths) == 1:
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(stem_paths[0]),
            "-t",
            f"{duration:.3f}",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-c:a",
            "libmp3lame",
            "-b:a",
            MIX_BITRATE,
            str(output_mp3),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "Failed to encode single-stem mix")
        return output_mp3

    cmd = ["ffmpeg", "-y"]
    for path in stem_paths:
        cmd.extend(["-i", str(path)])
    n = len(stem_paths)
    mix_inputs = "".join(f"[{i}:a]" for i in range(n))
    filter_complex = (
        f"{mix_inputs}amix=inputs={n}:duration=longest:dropout_transition=0:normalize=0,"
        f"aformat=channel_layouts=stereo,atrim=0:{duration:.3f},"
        f"asetpts=PTS-STARTPTS[aout]"
    )
    cmd.extend(
        [
            "-filter_complex",
            filter_complex,
            "-map",
            "[aout]",
            "-c:a",
            "libmp3lame",
            "-b:a",
            MIX_BITRATE,
            str(output_mp3),
        ]
    )
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Failed to mix stems")
    return output_mp3


def render_karaoke_mixes(
    *,
    media_dir: Path,
    source_mp3: Path,
    stems_dir: Path,
    on_progress: Optional[ProgressCallback] = None,
    should_cancel: Optional[CancelCallback] = None,
) -> list[str]:
    """Render mixes/*.mp3. Returns sorted list of mix filenames."""

    def progress(p: int, message: str) -> None:
        if on_progress:
            on_progress(p, message)

    def cancelled() -> bool:
        return bool(should_cancel and should_cancel())

    if not source_mp3.is_file():
        raise RuntimeError(f"Missing source audio: {source_mp3}")

    for stem_name in STEM_NAMES:
        if not (stems_dir / f"{stem_name}.wav").is_file():
            raise RuntimeError(f"Missing stem for mixes: {stem_name}.wav")

    mixes_dir = media_dir / "mixes"
    if mixes_dir.exists():
        shutil.rmtree(mixes_dir)
    mixes_dir.mkdir(parents=True, exist_ok=True)

    duration = _probe_duration(source_mp3)
    written: list[str] = []
    stem_names = discover_stem_names(stems_dir)
    ids = list(MIX_DEFINITIONS.keys()) + [stem_mix_id(name) for name in stem_names]
    total = max(1, len(ids))
    for i, mix_id in enumerate(ids):
        if cancelled():
            raise RuntimeError("Job was cancelled")
        pct = 70 + int(5 * (i / total))
        progress(pct, f"Rendering mix: {mix_id}")
        out = resolve_mix_path(media_dir, mix_id)
        if mix_id in MIX_DEFINITIONS:
            stem_set = MIX_DEFINITIONS[mix_id]
            if stem_set is None:
                _encode_original(source_mp3, out)
            else:
                stem_paths = [stems_dir / f"{name}.wav" for name in stem_set]
                mix_stems_to_mp3(stem_paths, out, duration)
        elif mix_id.startswith("stem-"):
            stem_name = mix_id[len("stem-") :]
            mix_stems_to_mp3([stems_dir / f"{stem_name}.wav"], out, duration)
        else:
            continue
        written.append(out.name)

    progress(75, f"Wrote {len(written)} mixes")
    return sorted(written)
