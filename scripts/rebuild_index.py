#!/usr/bin/env python3
"""Rebuild library/index.json from song markdown files."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.frontmatter import load_frontmatter

MEDIA_STATUSES = frozenset(
    {"none", "queued", "processing", "needs_review", "ready", "failed"}
)
AUDIO_SUFFIXES = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".opus", ".webm"}
VIDEO_SUFFIXES = {".mp4", ".webm", ".mkv", ".mov"}


def _normalize_media_status(value: Any) -> str:
    status = str(value or "none").strip().lower()
    return status if status in MEDIA_STATUSES else "none"


def media_flags_for_song(song_md: Path, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return media_status and filesystem-backed downloaded/processed flags."""
    meta = meta or {}
    media_dir = song_md.with_suffix("")
    youtube_dir = media_dir / "youtube"
    stems_dir = media_dir / "stems"
    mixes_dir = media_dir / "mixes"

    downloaded = False
    if (media_dir / "source.mp3").is_file():
        downloaded = True
    elif mixes_dir.is_dir() and any(
        p.is_file() and p.suffix.lower() == ".mp3" for p in mixes_dir.iterdir()
    ):
        # Pages / local snapshots may ship mixes without source.mp3 or video.
        downloaded = True
    elif youtube_dir.is_dir():
        for child in youtube_dir.iterdir():
            if not child.is_file():
                continue
            suffix = child.suffix.lower()
            if suffix in AUDIO_SUFFIXES or suffix in VIDEO_SUFFIXES:
                downloaded = True
                break
            if child.name in {"metadata.json", "poster.jpg", "poster.jpeg", "poster.png", "poster.webp"}:
                downloaded = True
                break

    processed = False
    if (media_dir / "lyrics.vtt").is_file() or (media_dir / "chords.vtt").is_file():
        processed = True
    elif mixes_dir.is_dir() and any(p.is_file() for p in mixes_dir.iterdir()):
        processed = True
    elif stems_dir.is_dir() and any(p.is_file() for p in stems_dir.iterdir()):
        processed = True

    media_status = _normalize_media_status(meta.get("media_status"))
    if media_status in {"needs_review", "ready"}:
        processed = True
        downloaded = True
    elif media_status == "processing" and downloaded:
        # Download finished; separation/alignment still running.
        pass

    has_mix_mp3 = mixes_dir.is_dir() and any(
        p.is_file() and p.suffix.lower() == ".mp3" for p in mixes_dir.iterdir()
    )
    has_source = (media_dir / "source.mp3").is_file()
    # Playable in the static player when a stereo mix (or source) exists.
    # Pages may ship charts/posters without mixes — those stay non-playable.
    media_playable = has_mix_mp3 or has_source

    youtube_url = str(meta.get("youtube_url") or "").strip()
    return {
        "media_status": media_status,
        "youtube_url": youtube_url,
        "media_downloaded": downloaded,
        "media_processed": processed,
        "media_playable": media_playable,
    }


def parse_song_file(path: Path, library_root: Path) -> dict[str, Any] | None:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None
    meta = load_frontmatter(parts[1]) or {}
    if not isinstance(meta, dict):
        return None
    rel = path.relative_to(library_root).as_posix()
    artist_slug = path.parent.parent.parent.name
    album_slug = path.parent.name
    song_slug = path.stem
    flags = media_flags_for_song(path, meta)
    return {
        "title": meta.get("title") or song_slug,
        "artist": meta.get("artist") or artist_slug,
        "album": meta.get("album") or album_slug,
        "artist_slug": artist_slug,
        "album_slug": album_slug,
        "song_slug": song_slug,
        "path": rel,
        "tuning": meta.get("tuning"),
        "capo": meta.get("capo", 0),
        "key": meta.get("key"),
        "difficulty": meta.get("difficulty"),
        "chords": meta.get("chords") or [],
        "scroll_speed": float(meta.get("scroll_speed") or 1.0),
        "start_delay": float(meta.get("start_delay") or 0),
        "source": meta.get("source") or "",
        "source_id": str(meta.get("source_id") or ""),
        "imported_at": meta.get("imported_at"),
        **flags,
    }


def rebuild_index(library_root: Path | None = None) -> dict[str, Any]:
    library_root = library_root or (ROOT / "library")
    songs: list[dict[str, Any]] = []
    artists_dir = library_root / "artists"
    if artists_dir.is_dir():
        for path in sorted(artists_dir.rglob("*.md")):
            entry = parse_song_file(path, library_root)
            if entry:
                songs.append(entry)

    artists: dict[str, Any] = {}
    for song in songs:
        a = song["artist_slug"]
        if a not in artists:
            artists[a] = {
                "name": song["artist"],
                "slug": a,
                "albums": {},
            }
        al = song["album_slug"]
        if al not in artists[a]["albums"]:
            artists[a]["albums"][al] = {
                "name": song["album"],
                "slug": al,
                "songs": [],
            }
        artists[a]["albums"][al]["songs"].append(
            {
                "title": song["title"],
                "slug": song["song_slug"],
                "path": song["path"],
            }
        )

    # Convert albums dicts to sorted lists for stable JSON
    artist_list = []
    for a_slug in sorted(artists.keys()):
        a = artists[a_slug]
        album_list = []
        for al_slug in sorted(a["albums"].keys()):
            album = a["albums"][al_slug]
            album["songs"] = sorted(album["songs"], key=lambda s: s["title"].lower())
            album_list.append(album)
        artist_list.append(
            {
                "name": a["name"],
                "slug": a["slug"],
                "albums": album_list,
            }
        )
    artist_list.sort(key=lambda x: x["name"].lower())

    index = {
        "generated": True,
        "song_count": len(songs),
        "artists": artist_list,
        "songs": sorted(songs, key=lambda s: (s["artist"].lower(), s["album"].lower(), s["title"].lower())),
    }
    library_root.mkdir(parents=True, exist_ok=True)
    out = library_root / "index.json"
    out.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return index


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Rebuild library/index.json")
    parser.add_argument(
        "--library",
        type=Path,
        default=None,
        help="Library root (default: ./library)",
    )
    args = parser.parse_args(argv)
    index = rebuild_index(args.library)
    print(f"Indexed {index['song_count']} song(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
