#!/usr/bin/env python3
"""Convert parsed UG tab data into YAML-frontmatter monospace markdown."""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.frontmatter import dump_frontmatter

TAG_RE = re.compile(r"\[/?tab\]", re.IGNORECASE)
CH_RE = re.compile(r"\[ch\](.*?)\[/ch\]", re.IGNORECASE)
NBSP_RE = re.compile(r"[\u00a0\u202f\u2007]")
TRAILING_X_RE = re.compile(r"(?m)^\s*X\s*$")
CHORD_TOKEN_RE = re.compile(
    r"\b([A-G](?:#|b)?(?:(?:maj|min|dim|aug|sus|add|M|m)?[0-9]*(?:[#b][0-9]+)?){0,3}"
    r"(?:\([#b0-9]+\))?(?:/[A-G](?:#|b)?)?)(?!\w)"
)


def is_chord_line(line: str) -> bool:
    """True when a line is mostly chord symbols (a chord row above lyrics)."""
    stripped = line.strip()
    if not stripped or stripped.startswith("["):
        return False
    # ASCII tab notation (e.g. "Ab|-0-------0-------|") is not a chord row
    if "|" in stripped:
        return False
    tokens = CHORD_TOKEN_RE.findall(stripped)
    if not tokens:
        return False
    remainder = CHORD_TOKEN_RE.sub("", stripped)
    remainder = re.sub(r"[\s|/.\-xX#]+", "", remainder)
    return len(remainder) <= 2


def ensure_space_above_chord_lines(lines: list[str]) -> list[str]:
    """Insert a blank line above each chord line when the previous line isn't blank."""
    out: list[str] = []
    for line in lines:
        if is_chord_line(line) and out and out[-1].strip():
            out.append("")
        out.append(line)
    return out


def clean_ug_content(raw: str) -> str:
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    text = NBSP_RE.sub(" ", text)
    text = TAG_RE.sub("", text)
    text = CH_RE.sub(r"\1", text)
    text = TRAILING_X_RE.sub("", text)
    # Drop leading chord-diagram dump lines like "C/B Chord EADGBe" / "x20010"
    lines = text.split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    cleaned: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if re.match(r"^.+\s+Chord\s+EADGBe\s*$", stripped, re.IGNORECASE):
            i += 1
            if i < len(lines) and re.match(r"^[x0-9\-]+$", lines[i].strip(), re.IGNORECASE):
                i += 1
            while i < len(lines) and not lines[i].strip():
                i += 1
            continue
        cleaned.append(line.rstrip())
        i += 1
    cleaned = ensure_space_above_chord_lines(cleaned)
    # Collapse 3+ blank lines to 2
    out = "\n".join(cleaned)
    out = re.sub(r"\n{3,}", "\n\n", out).strip() + "\n"
    return out


def build_frontmatter(meta: dict[str, Any], imported_at: str | None = None) -> dict[str, Any]:
    key = meta.get("key")
    if key == "":
        key = None
    return {
        "title": meta["title"],
        "artist": meta["artist"],
        "album": meta.get("album") or "singles",
        "tuning": meta.get("tuning") or "E A D G B E",
        "capo": int(meta.get("capo") or 0),
        "key": key,
        "difficulty": meta.get("difficulty"),
        "source": meta.get("source") or "",
        "source_id": str(meta.get("source_id") or ""),
        "imported_at": imported_at or date.today().isoformat(),
        "scroll_speed": float(meta.get("scroll_speed") or 1.0),
        "start_delay": float(meta.get("start_delay") or 0),
        "chords": list(meta.get("chords") or []),
    }


def to_markdown(meta: dict[str, Any], imported_at: str | None = None) -> str:
    fm = build_frontmatter(meta, imported_at=imported_at)
    body = clean_ug_content(meta.get("content_raw") or "")
    dumped = dump_frontmatter(fm)
    return f"---\n{dumped}---\n\n```\n{body.rstrip()}\n```\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Convert parsed UG JSON to markdown")
    parser.add_argument("json_file", help="Parsed JSON path (or - for stdin)")
    parser.add_argument("-o", "--output", help="Write markdown to file")
    args = parser.parse_args(argv)
    raw = sys.stdin.read() if args.json_file == "-" else Path(args.json_file).read_text(encoding="utf-8")
    meta = json.loads(raw)
    md = to_markdown(meta)
    if args.output:
        Path(args.output).write_text(md, encoding="utf-8")
    else:
        sys.stdout.write(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
