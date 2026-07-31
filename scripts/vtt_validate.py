"""Validate lyrics.vtt + chords.vtt before save / verify."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class Cue:
    start: float
    end: float
    text: str


def parse_vtt_time(value: str) -> Optional[float]:
    parts = str(value or "").split(":")
    try:
        if len(parts) == 3:
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
        if len(parts) == 2:
            return float(parts[0]) * 60 + float(parts[1])
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_vtt(text: str) -> list[Cue]:
    cues: list[Cue] = []
    blocks = re.split(r"\n\n+", str(text or "").lstrip("\ufeff"))
    for block in blocks:
        lines = [ln for ln in block.split("\n") if ln.strip() and ln.strip() != "WEBVTT"]
        if not lines:
            continue
        time_line = lines[0]
        text_lines = lines[1:]
        if "-->" not in time_line and len(lines) > 1 and "-->" in lines[1]:
            time_line = lines[1]
            text_lines = lines[2:]
        if "-->" not in time_line:
            continue
        start_raw, end_raw = [p.strip().split()[0] for p in time_line.split("-->")]
        start = parse_vtt_time(start_raw)
        end = parse_vtt_time(end_raw)
        if start is None or end is None:
            continue
        cues.append(Cue(start=start, end=end, text=" ".join(text_lines).strip()))
    return cues


def format_vtt_time(seconds: float) -> str:
    s = max(0.0, float(seconds or 0.0))
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = s % 60
    return f"{h:02d}:{m:02d}:{sec:06.3f}"


def _normalize_lyric_key(text: str) -> str:
    cleaned = re.sub(r"[^\w\s']", "", (text or "").lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def _parse_chord_cue(cue: Cue) -> dict[str, Any]:
    raw = (cue.text or "").strip()
    match = re.match(r"^(.*)\|(\d+)$", raw)
    if match:
        return {
            "name": match.group(1).strip(),
            "column": int(match.group(2)),
            "start": cue.start,
            "end": cue.end,
        }
    return {"name": raw, "column": None, "start": cue.start, "end": cue.end}


def validate_media_vtt(
    lyrics_cues: list[Cue],
    chords_cues: list[Cue],
) -> dict[str, Any]:
    """Return {ok, errors, warnings, issues}. Errors block save; either blocks verify."""
    errors: list[str] = []
    warnings: list[str] = []
    lyrics = list(lyrics_cues or [])
    chords = list(chords_cues or [])

    prev_start = float("-inf")
    for i, cue in enumerate(lyrics, start=1):
        text = (cue.text or "").strip()
        if cue.end <= cue.start:
            errors.append(f"Lyric cue {i}: end must be after start ({format_vtt_time(cue.start)})")
        if cue.start < prev_start - 0.001:
            errors.append(
                f"Lyric cue {i}: out of chronological order "
                f"(starts {format_vtt_time(cue.start)} after previous {format_vtt_time(prev_start)})"
            )
        else:
            prev_start = cue.start
        dur = cue.end - cue.start
        if text and text != "·" and dur < 0.1:
            warnings.append(f'Lyric cue {i} is very short ({round(dur * 1000)}ms): "{text}"')

    seen_starts: dict[str, int] = {}
    for i, cue in enumerate(lyrics, start=1):
        key = f"{_normalize_lyric_key(cue.text)}|{cue.start:.3f}"
        if key.startswith("|"):
            continue
        if key in seen_starts:
            warnings.append(
                f"Lyric cue {i} duplicates cue {seen_starts[key]} at {format_vtt_time(cue.start)}"
            )
        else:
            seen_starts[key] = i

    for i, cue in enumerate(chords, start=1):
        if cue.end <= cue.start:
            errors.append(f"Chord cue {i}: end must be after start ({format_vtt_time(cue.start)})")
        parsed = _parse_chord_cue(cue)
        if not parsed["name"] or parsed["column"] is None or parsed["column"] < 0:
            errors.append(f'Chord cue {i}: expected Name|column, got "{cue.text or ""}"')

    ordered = sorted(lyrics, key=lambda c: (c.start, c.end))
    for idx, cue in enumerate(ordered):
        text = (cue.text or "").strip()
        if not text:
            continue
        next_cue = ordered[idx + 1] if idx + 1 < len(ordered) else None
        until = next_cue.start if next_cue is not None else cue.end
        attached = []
        for c in chords:
            parsed = _parse_chord_cue(c)
            if not parsed["name"]:
                continue
            if parsed["start"] >= cue.start - 0.001 and parsed["start"] < until - 0.001:
                attached.append(parsed)
        col_hits: dict[int, int] = {}
        collisions = 0
        for c in attached:
            col = c["column"] if isinstance(c.get("column"), int) else 0
            prev = col_hits.get(col, 0)
            if prev:
                collisions += 1
            col_hits[col] = prev + 1
        if len(attached) > 18 or collisions > 2:
            msg = (
                f'Lyric "{text}" at {format_vtt_time(cue.start)} attaches {len(attached)} chords'
            )
            if collisions:
                msg += f" with {collisions} column collisions"
            msg += " — fix lyric timing order before going live"
            warnings.append(msg)

    return {
        "ok": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "issues": errors + warnings,
    }


def validate_vtt_pair_text(lyrics_text: str, chords_text: str) -> dict[str, Any]:
    return validate_media_vtt(parse_vtt(lyrics_text), parse_vtt(chords_text))


def validate_kind_content(kind: str, content: str) -> dict[str, Any]:
    """Lightweight single-file checks used on PUT /api/media/vtt."""
    cues = parse_vtt(content)
    errors: list[str] = []
    warnings: list[str] = []
    if kind == "lyrics":
        prev_start = float("-inf")
        for i, cue in enumerate(cues, start=1):
            if cue.end <= cue.start:
                errors.append(f"Lyric cue {i}: end must be after start")
            if cue.start < prev_start - 0.001:
                errors.append(f"Lyric cue {i}: out of chronological order")
            else:
                prev_start = cue.start
            if (cue.text or "").strip() not in ("", "·") and (cue.end - cue.start) < 0.1:
                warnings.append(f"Lyric cue {i} is very short ({round((cue.end - cue.start) * 1000)}ms)")
    elif kind == "chords":
        for i, cue in enumerate(cues, start=1):
            if cue.end <= cue.start:
                errors.append(f"Chord cue {i}: end must be after start")
            parsed = _parse_chord_cue(cue)
            if not parsed["name"] or parsed["column"] is None or parsed["column"] < 0:
                errors.append(f'Chord cue {i}: expected Name|column, got "{cue.text or ""}"')
    else:
        errors.append("kind must be lyrics or chords")
    return {
        "ok": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "issues": errors + warnings,
    }
