"""Update instrument-karaoke song markdown frontmatter from the media worker."""

from __future__ import annotations

import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)


def _replace_or_insert_frontmatter_field(fm: str, key: str, value: str) -> str:
    pattern = re.compile(rf"(?m)^{re.escape(key)}:\s*.*$")
    line = f"{key}: {value}"
    if pattern.search(fm):
        return pattern.sub(line, fm, count=1)
    # Insert before trailing blank lines
    return fm.rstrip() + "\n" + line + "\n"


def update_song_media_fields(
    song_md: Path,
    *,
    media_status: str,
    youtube_url: str | None = None,
    media_verified_at: str | None = None,
) -> None:
    if not song_md.is_file():
        logger.warning("Song markdown missing: %s", song_md)
        return
    raw = song_md.read_text(encoding="utf-8")
    if not raw.startswith("---"):
        return
    end = raw.find("\n---", 3)
    if end < 0:
        return
    fm = raw[3:end].lstrip("\n")
    rest = raw[end:]
    fm = _replace_or_insert_frontmatter_field(fm, "media_status", media_status)
    if youtube_url is not None:
        # quote URL for YAML safety
        quoted = json_quote(youtube_url)
        fm = _replace_or_insert_frontmatter_field(fm, "youtube_url", quoted)
    if media_verified_at is None and media_status != "ready":
        fm = _replace_or_insert_frontmatter_field(fm, "media_verified_at", "null")
    elif media_verified_at is not None:
        fm = _replace_or_insert_frontmatter_field(fm, "media_verified_at", json_quote(media_verified_at))
    song_md.write_text(f"---\n{fm.rstrip()}\n{rest}", encoding="utf-8")


def json_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'
