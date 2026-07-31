#!/usr/bin/env python3
"""Parse Ultimate-Guitar tab HTML / js-store JSON into structured data."""

from __future__ import annotations

import argparse
import html as html_lib
import json
import re
import sys
from pathlib import Path
from typing import Any

JS_STORE_RE = re.compile(
    r'<div[^>]*\bclass="[^"]*\bjs-store\b[^"]*"[^>]*\bdata-content="([^"]+)"',
    re.IGNORECASE,
)
DATA_CONTENT_RE = re.compile(r'\bdata-content="([^"]+)"', re.IGNORECASE)


def extract_js_store(html: str) -> dict[str, Any]:
    match = JS_STORE_RE.search(html) or DATA_CONTENT_RE.search(html)
    if not match:
        raise ValueError("No js-store data-content found in HTML")
    raw = html_lib.unescape(match.group(1))
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("js-store data-content is not a JSON object")
    return data


def _get(data: dict[str, Any], *path: str) -> Any:
    cur: Any = data
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    return cur


def _capo_from_meta(meta: dict[str, Any] | None) -> int:
    if not meta:
        return 0
    for key in ("capo", "capo_fret", "capoFret"):
        if key in meta and meta[key] is not None:
            try:
                return int(meta[key])
            except (TypeError, ValueError):
                pass
    # UI sometimes stores capo under nested objects
    for value in meta.values():
        if isinstance(value, dict) and "capo" in value:
            try:
                return int(value["capo"])
            except (TypeError, ValueError):
                pass
    return 0


def _album_name(tab: dict[str, Any]) -> str | None:
    recording = tab.get("recording") or {}
    if isinstance(recording, dict):
        for key in ("album_name", "name", "title"):
            if recording.get(key):
                return str(recording[key])
    cover = tab.get("album_cover") or {}
    if isinstance(cover, dict) and cover.get("album_name"):
        return str(cover["album_name"])
    if tab.get("album_name"):
        return str(tab["album_name"])
    return None


def _chord_names(tab_view: dict[str, Any], content: str) -> list[str]:
    applicature = tab_view.get("applicature") or {}
    if isinstance(applicature, dict) and applicature:
        return list(applicature.keys())
    found = re.findall(r"\[ch\]([^\[]+?)\[/ch\]", content)
    # preserve order, unique
    seen: set[str] = set()
    out: list[str] = []
    for name in found:
        if name not in seen:
            seen.add(name)
            out.append(name)
    return out


def _voicing_from_ug(v: dict[str, Any]) -> dict[str, Any] | None:
    frets = v.get("frets") or []
    if not isinstance(frets, list) or not frets:
        return None
    fingers = v.get("fingers") or []
    base = int(v.get("fret") or 0) or 1
    # UG uses fret 0 as open; our renderer uses base_fret 1 for open shapes
    if base <= 0:
        base = 1
    # UG stores frets/fingers high-E → low-E; diagrams expect low-E → high-E.
    frets_out = list(reversed(frets))
    fingers_out = list(reversed(fingers)) if isinstance(fingers, list) else []
    return {
        "frets": frets_out,
        "fingers": fingers_out,
        "base_fret": base,
        "barre": None,
    }


def _shapes_from_applicature(applicature: Any) -> dict[str, list[dict[str, Any]]]:
    """Extract all voicings per chord for chord-shapes export."""
    shapes: dict[str, list[dict[str, Any]]] = {}
    if not isinstance(applicature, dict):
        return shapes
    for name, voicings in applicature.items():
        if not isinstance(voicings, list) or not voicings:
            continue
        out: list[dict[str, Any]] = []
        seen: set[tuple] = set()
        for v in voicings:
            if not isinstance(v, dict):
                continue
            shape = _voicing_from_ug(v)
            if not shape:
                continue
            key = tuple(shape["frets"])
            if key in seen:
                continue
            seen.add(key)
            out.append(shape)
        if out:
            shapes[name] = out
    return shapes


def parse_store(data: dict[str, Any], source_url: str | None = None) -> dict[str, Any]:
    tab = _get(data, "store", "page", "data", "tab") or {}
    tab_view = _get(data, "store", "page", "data", "tab_view") or {}
    if not tab and not tab_view:
        raise ValueError("Missing store.page.data.tab / tab_view in js-store")

    wiki = tab_view.get("wiki_tab") or {}
    content = wiki.get("content") or ""
    if not content:
        raise ValueError("Empty wiki_tab.content")

    meta = tab_view.get("meta") or {}
    tuning_obj = meta.get("tuning") if isinstance(meta, dict) else None
    if isinstance(tuning_obj, dict):
        tuning = tuning_obj.get("value") or "E A D G B E"
    elif isinstance(tuning_obj, str):
        tuning = tuning_obj
    else:
        tuning = "E A D G B E"

    difficulty = (tab.get("difficulty") or tab.get("ug_difficulty") or "").strip() or None
    album = _album_name(tab) or "singles"
    source = source_url or tab.get("tab_url") or ""
    source_id = str(tab.get("id") or "")

    return {
        "title": tab.get("song_name") or tab.get("localized_song_name") or "Untitled",
        "artist": tab.get("artist_name") or tab.get("localized_artist_name") or "Unknown",
        "album": album,
        "tuning": tuning,
        "capo": _capo_from_meta(meta if isinstance(meta, dict) else None),
        "key": (tab.get("tonality_name") or None) or None,
        "difficulty": difficulty.lower() if isinstance(difficulty, str) else difficulty,
        "source": source,
        "source_id": source_id,
        "chords": _chord_names(tab_view, content),
        "content_raw": content,
        "shapes": _shapes_from_applicature(tab_view.get("applicature")),
    }


def parse_html(html: str, source_url: str | None = None) -> dict[str, Any]:
    return parse_store(extract_js_store(html), source_url=source_url)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Parse UG tab HTML to JSON")
    parser.add_argument("html_file", help="Path to UG HTML (or - for stdin)")
    parser.add_argument("--url", default=None, help="Source URL override")
    args = parser.parse_args(argv)
    html = sys.stdin.read() if args.html_file == "-" else Path(args.html_file).read_text(encoding="utf-8")
    try:
        parsed = parse_html(html, source_url=args.url)
    except (ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    # don't dump huge shapes in default CLI unless present — include them
    print(json.dumps(parsed, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
