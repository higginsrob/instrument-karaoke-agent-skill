from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from server.config import settings


def normalize_song_path(song_path: str) -> str:
    cleaned = song_path.strip().lstrip("/").replace("\\", "/")
    if cleaned.startswith("library/"):
        cleaned = cleaned[len("library/") :]
    if ".." in cleaned.split("/"):
        raise ValueError("Path must not contain '..'")
    if not cleaned.startswith("artists/") or not cleaned.endswith(".md"):
        raise ValueError("Path must be under artists/ and end with .md")
    return cleaned


def song_md_path(song_path: str) -> Path:
    rel = normalize_song_path(song_path)
    target = (settings.library_dir / rel).resolve()
    artists_root = (settings.library_dir / "artists").resolve()
    if not str(target).startswith(str(artists_root) + "/") and target != artists_root:
        raise ValueError("Path escapes library/artists")
    return target


def media_dir_for_song(song_path: str) -> Path:
    """Sibling directory of the .md file: artists/.../slug/."""
    return song_md_path(song_path).with_suffix("")


# Re-export for callers that need the markdown path
__all__ = [
    "normalize_song_path",
    "song_md_path",
    "media_dir_for_song",
    "write_media_json",
    "read_media_json",
]


def write_media_json(media_dir: Path, payload: dict[str, Any]) -> None:
    media_dir.mkdir(parents=True, exist_ok=True)
    path = media_dir / "media.json"
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def read_media_json(media_dir: Path) -> dict[str, Any]:
    path = media_dir / "media.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}
