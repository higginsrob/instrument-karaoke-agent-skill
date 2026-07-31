#!/usr/bin/env python3
"""Normalize an existing song markdown file (frontmatter + body cleanup)."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.frontmatter import dump_frontmatter, load_frontmatter
from scripts.ug_to_markdown import CHORD_TOKEN_RE, clean_ug_content, is_chord_line


def extract_chords_from_body(body: str) -> list[str]:
    # Prefer chord-only lines (mostly chord symbols / spaces)
    lines = body.splitlines()
    found: list[str] = []
    seen: set[str] = set()
    for line in lines:
        if not is_chord_line(line):
            continue
        for t in CHORD_TOKEN_RE.findall(line.strip()):
            if t not in seen:
                seen.add(t)
                found.append(t)
    return found


def cleanup_song(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        raise ValueError(f"No YAML frontmatter: {path}")
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise ValueError(f"Malformed frontmatter: {path}")
    meta = load_frontmatter(parts[1]) or {}
    body = parts[2].strip()
    # Unwrap fenced code if present
    fence = re.match(r"^```(?:text|chord|chords)?\n([\s\S]*?)\n```\s*$", body)
    if fence:
        raw_body = fence.group(1)
    else:
        raw_body = body
    cleaned = clean_ug_content(raw_body)
    chords = meta.get("chords") or extract_chords_from_body(cleaned)
    meta["chords"] = chords
    dumped = dump_frontmatter(meta)
    path.write_text(f"---\n{dumped}---\n\n```\n{cleaned.rstrip()}\n```\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Clean up a song markdown file")
    parser.add_argument("path", type=Path, help="Path to song .md")
    args = parser.parse_args(argv)
    try:
        cleanup_song(args.path)
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"Cleaned {args.path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
