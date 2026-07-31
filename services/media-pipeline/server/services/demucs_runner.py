from __future__ import annotations

import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Callable, Optional

from server.config import settings

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[int, str], None]
CancelCallback = Callable[[], bool]

STEM_NAMES = ("vocals", "drums", "bass", "other")
_SHIMS_DIR = Path(__file__).resolve().parent.parent / "shims"


def _demucs_env() -> dict[str, str]:
    env = dict(os.environ)
    prefix = str(_SHIMS_DIR)
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = prefix if not existing else f"{prefix}{os.pathsep}{existing}"
    env["TORCH_HOME"] = str(settings.models_dir)
    return env


def run_demucs(
    *,
    input_file: Path,
    stems_dir: Path,
    on_progress: ProgressCallback,
    should_cancel: CancelCallback,
    model_name: Optional[str] = None,
) -> list[Path]:
    """Run htdemucs and copy flat stem wavs into stems_dir."""
    model = model_name or settings.demucs_model
    work_dir = stems_dir.parent / "_demucs_work"
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    stems_dir.mkdir(parents=True, exist_ok=True)

    on_progress(35, f"Separating stems ({model})")
    cmd = [
        "python3",
        "-m",
        "demucs",
        "-n",
        model,
        "--out",
        str(work_dir),
        "-d",
        settings.demucs_device,
        "--overlap",
        str(settings.demucs_overlap),
        str(input_file),
    ]
    if should_cancel():
        raise RuntimeError("Job was cancelled")

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=_demucs_env(),
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        logger.debug("demucs: %s", line.rstrip())
        if should_cancel():
            proc.terminate()
            raise RuntimeError("Job was cancelled")
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f"Demucs failed with exit code {code}")

    # demucs writes work_dir/<model>/<track_stem>/<stem>.wav
    model_out = work_dir / model
    track_dirs = [p for p in model_out.iterdir() if p.is_dir()] if model_out.is_dir() else []
    if not track_dirs:
        raise RuntimeError("Demucs produced no stem directory")
    track_dir = track_dirs[0]

    written: list[Path] = []
    missing: list[str] = []
    for stem_name in STEM_NAMES:
        src = track_dir / f"{stem_name}.wav"
        if not src.is_file():
            missing.append(stem_name)
            continue
        dest = stems_dir / f"{stem_name}.wav"
        shutil.copy2(src, dest)
        written.append(dest)

    if missing:
        raise RuntimeError(f"Demucs missing required stems: {', '.join(missing)}")
    if not written:
        raise RuntimeError("Demucs produced no stem wav files")

    on_progress(70, f"Wrote {len(written)} stems")
    shutil.rmtree(work_dir, ignore_errors=True)
    return written
