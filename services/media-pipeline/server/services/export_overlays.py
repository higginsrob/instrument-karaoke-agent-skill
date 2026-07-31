"""Pillow port of MediaAnalysis.drawFrame overlays for offline video export."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from server.services.chart_extract import extract_chart_groups

# Lazy: unit tests import parse_vtt / window helpers without Pillow installed in CI.
Image = None
ImageDraw = None
ImageFont = None


def _require_pil() -> None:
    global Image, ImageDraw, ImageFont
    if Image is not None:
        return
    from PIL import Image as _Image
    from PIL import ImageDraw as _ImageDraw
    from PIL import ImageFont as _ImageFont

    Image = _Image
    ImageDraw = _ImageDraw
    ImageFont = _ImageFont

PLAYHEAD_RATIO = 0.35
# Live preview is typically ~900px wide with an 8s window (~112 px/s).
# Scale the export time window with output width so drums don't race on 1080p.
REF_LAYOUT_WIDTH = 900.0
BASE_WINDOW_SECONDS = 8.0
DRUM_LANES = ["crash", "hihat", "snare", "tom", "kick"]
DRUM_COLORS = {
    "kick": (196, 92, 92, 255),
    "tom": (212, 137, 74, 255),
    "snare": (201, 162, 39, 255),
    "hihat": (58, 154, 122, 255),
    "crash": (74, 143, 200, 255),
}

FONTS_DIR = Path(__file__).resolve().parents[1] / "assets" / "fonts"


def layout_scale(width: int) -> float:
    """Scale UI from the ~900px CSS preview up to export resolution."""
    return max(1.0, float(width) / REF_LAYOUT_WIDTH)


def window_seconds_for_width(width: int) -> float:
    """Keep horizontal scroll speed close to the live preview."""
    scale = layout_scale(width)
    # Slightly slower than a pure px/s match so HD exports stay readable.
    return max(BASE_WINDOW_SECONDS, min(22.0, BASE_WINDOW_SECONDS * scale * 1.15))


@dataclass
class Cue:
    start: float
    end: float
    text: str


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
        start = _parse_vtt_time(start_raw)
        end = _parse_vtt_time(end_raw)
        if start is None or end is None:
            continue
        cues.append(Cue(start=start, end=end, text=" ".join(text_lines).strip()))
    return cues


def _parse_vtt_time(value: str) -> Optional[float]:
    parts = str(value or "").split(":")
    try:
        if len(parts) == 3:
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
        if len(parts) == 2:
            return float(parts[0]) * 60 + float(parts[1])
        return float(value)
    except (TypeError, ValueError):
        return None


def load_cues(path: Path) -> list[Cue]:
    if not path.is_file():
        return []
    return parse_vtt(path.read_text(encoding="utf-8"))


def load_drums(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"onsets": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"onsets": []}
    if not isinstance(data, dict):
        return {"onsets": []}
    return data


def compute_viewport(
    current_time: float,
    duration: float,
    *,
    window_seconds: float = BASE_WINDOW_SECONDS,
) -> dict[str, float]:
    window = max(4.0, float(window_seconds))
    half = window * PLAYHEAD_RATIO
    t = max(0.0, float(current_time or 0.0))
    dur = float(duration) if duration and duration > 0 else 0.0
    start = t - half
    end = start + window
    if dur and dur > window and end > dur:
        end = dur
        start = end - window
    return {"start": start, "end": end, "playheadRatio": PLAYHEAD_RATIO, "window": window}


def time_to_x(time: float, viewport: dict[str, float], width: float) -> float:
    span = max(0.001, viewport["end"] - viewport["start"])
    return ((time - viewport["start"]) / span) * width


def _font(path: Path, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    _require_pil()
    try:
        return ImageFont.truetype(str(path), size=size)
    except OSError:
        return ImageFont.load_default()


def _text_width(font: ImageFont.ImageFont, text: str) -> float:
    if hasattr(font, "getlength"):
        try:
            return float(font.getlength(text))
        except Exception:
            pass
    bbox = font.getbbox(text or "")
    return float(bbox[2] - bbox[0]) if bbox else 0.0


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


def _chords_for_lyric(cue: Cue, chords_cues: list[Cue], next_cue_start: Optional[float]) -> list[dict[str, Any]]:
    start = cue.start
    end = next_cue_start if next_cue_start is not None else cue.end
    out = []
    for c in chords_cues:
        parsed = _parse_chord_cue(c)
        if not parsed["name"]:
            continue
        if parsed["start"] >= start - 0.001 and parsed["start"] < end - 0.001:
            out.append(parsed)
    out.sort(key=lambda c: c["start"])
    return out


def _build_lyric_segments(
    font: ImageFont.ImageFont,
    cues: list[Cue],
    chords_cues: list[Cue],
) -> list[dict[str, Any]]:
    gap = "   "
    gap_w = _text_width(font, gap)
    space_w = _text_width(font, " ")
    segments: list[dict[str, Any]] = []
    cursor = 0.0
    # Chronological order bounds chord attachment to the next lyric start.
    ordered = sorted(cues or [], key=lambda c: (c.start, c.end))
    for index, cue in enumerate(ordered):
        text = re.sub(r"\n+", " ", cue.text or "").strip()
        if not text:
            continue
        if segments:
            cursor += gap_w
        next_cue = ordered[index + 1] if index + 1 < len(ordered) else None
        line_chords = _chords_for_lyric(cue, chords_cues, next_cue.start if next_cue else None)
        max_col = max(
            [len(text)]
            + [
                (c["column"] + len(c["name"])) if isinstance(c.get("column"), int) else 0
                for c in line_chords
            ]
            + [0]
        )
        text_width = _text_width(font, text)
        sheet_width = max(text_width, max_col * space_w)
        segments.append(
            {
                "cue": cue,
                "index": index,
                "text": text,
                "textStartPx": cursor,
                "textWidth": text_width,
                "sheetWidth": sheet_width,
                "spaceW": space_w,
                "gapW": gap_w,
                "lineChords": line_chords,
                "nextStart": next_cue.start if next_cue else None,
            }
        )
        cursor += sheet_width
    return segments


def _karaoke_approach_pps(seg: dict[str, Any]) -> float:
    cue = seg["cue"]
    dur = max(0.8, (cue.end or 0) - (cue.start or 0))
    width = max(seg.get("textWidth") or 0, 1)
    return max(28.0, min(90.0, width / dur))


def _karaoke_sing_px(segments: list[dict[str, Any]], current_time: float) -> float:
    if not segments:
        return 0.0
    first = segments[0]
    if current_time < first["cue"].start:
        pps = _karaoke_approach_pps(first)
        return first["textStartPx"] - (first["cue"].start - current_time) * pps
    last = segments[-1]
    last_sheet = max(last.get("sheetWidth") or 0, last.get("textWidth") or 0)
    last_hang = last["nextStart"] if last["nextStart"] is not None else last["cue"].end
    if current_time >= last_hang:
        return last["textStartPx"] + last_sheet
    for i, seg in enumerate(segments):
        text_w = max(seg.get("textWidth") or 0, 0)
        sheet_w = max(seg.get("sheetWidth") or 0, text_w)
        trail_w = max(0.0, sheet_w - text_w)
        next_seg = segments[i + 1] if i + 1 < len(segments) else None

        if current_time >= seg["cue"].start and current_time < seg["cue"].end:
            has_gap = bool(next_seg and next_seg["cue"].start > seg["cue"].end + 0.001)
            scroll_w = text_w if has_gap else sheet_w
            p = (current_time - seg["cue"].start) / max(0.05, seg["cue"].end - seg["cue"].start)
            return seg["textStartPx"] + p * scroll_w

        if next_seg and current_time >= seg["cue"].end and current_time < next_seg["cue"].start:
            text_end_px = seg["textStartPx"] + text_w
            sheet_end_px = seg["textStartPx"] + sheet_w
            arrive_px = next_seg["textStartPx"]
            gap_dur = max(0.05, next_seg["cue"].start - seg["cue"].end)
            pps = _karaoke_approach_pps(next_seg)
            approach_px = max(0.0, arrive_px - sheet_end_px)
            approach_sec = approach_px / max(1.0, pps)

            if trail_w > 0:
                trail_sec = max(0.05, gap_dur - approach_sec)
                trail_elapsed = current_time - seg["cue"].end
                if trail_elapsed < trail_sec:
                    return text_end_px + (trail_elapsed / trail_sec) * trail_w

            time_to_next = next_seg["cue"].start - current_time
            if time_to_next > approach_sec:
                return sheet_end_px
            return arrive_px - time_to_next * pps

        if not next_seg and current_time >= seg["cue"].end:
            if trail_w > 0:
                hang = 1.5
                trail_elapsed = current_time - seg["cue"].end
                p = min(1.0, trail_elapsed / hang)
                return seg["textStartPx"] + text_w + p * trail_w
            return seg["textStartPx"] + sheet_w
    return 0.0


def _rgba(color: tuple[int, int, int, int], alpha: float) -> tuple[int, int, int, int]:
    r, g, b, a = color
    return (r, g, b, max(0, min(255, int(round(a * alpha)))))


def _normalize_lyric_key(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s']", "", (text or "").lower())).strip()


def _smoothstep01(t: float) -> float:
    x = max(0.0, min(1.0, float(t)))
    return x * x * (3.0 - 2.0 * x)


def playing_sync_line_index(lines: list[dict[str, Any]], current_time: float) -> int:
    t = float(current_time or 0.0)
    active = -1
    for i, line in enumerate(lines or []):
        start = line.get("start")
        if not isinstance(start, (int, float)):
            continue
        end = None
        for j in range(i + 1, len(lines)):
            ns = lines[j].get("start")
            if isinstance(ns, (int, float)):
                end = float(ns)
                break
        if end is None:
            le = line.get("end")
            end = float(le) if isinstance(le, (int, float)) else float(start) + 3.0
        if t >= float(start) and t < float(end):
            active = i
    return active


def sync_line_window_end(lines: list[dict[str, Any]], index: int) -> Optional[float]:
    if index < 0 or index >= len(lines):
        return None
    line = lines[index]
    start = line.get("start")
    if not isinstance(start, (int, float)):
        return None
    for j in range(index + 1, len(lines)):
        ns = lines[j].get("start")
        if isinstance(ns, (int, float)):
            return float(ns)
    le = line.get("end")
    return float(le) if isinstance(le, (int, float)) else float(start) + 3.0


def format_sync_chord_line(line: dict[str, Any]) -> str:
    chords = [c for c in (line.get("chords") or []) if c and c.get("name")]
    if not chords:
        return ""
    lyric_len = len(str(line.get("lyric") or ""))
    max_col = max(
        [lyric_len]
        + [
            (int(c["column"]) if isinstance(c.get("column"), int) else 0) + len(str(c["name"]))
            for c in chords
        ]
        + [1]
    )
    chars = [" "] * max_col
    for chord in chords:
        col = int(chord["column"]) if isinstance(chord.get("column"), int) else 0
        col = max(0, col)
        name = str(chord["name"])
        for i, ch in enumerate(name):
            if col + i < len(chars):
                chars[col + i] = ch
    placed = "".join(chars).rstrip()
    return placed or " ".join(str(c["name"]) for c in chords)


def build_sync_lines(
    chart_body: str,
    lyrics_cues: list[Cue],
    chords_cues: list[Cue],
) -> list[dict[str, Any]]:
    """Hydrate chart groups with VTT timings (mirrors MediaAnalysis.hydrateSyncLines)."""
    groups = extract_chart_groups(chart_body) if chart_body else []
    cues = sorted(list(lyrics_cues or []), key=lambda c: c.start)
    if not groups:
        out = []
        for cue in cues:
            out.append(
                {
                    "lyric": cue.text or "",
                    "chords": [],
                    "start": cue.start,
                    "end": cue.end,
                }
            )
        return out

    cursor = 0
    lines: list[dict[str, Any]] = []
    for g in groups:
        lyric = g.lyric or ""
        chords = [{"name": c.name, "column": c.column} for c in (g.chords or [])]
        line: dict[str, Any] = {
            "lyric": lyric,
            "chords": chords,
            "start": None,
            "end": None,
        }
        if not lyric and not chords:
            lines.append(line)
            continue
        key = _normalize_lyric_key(lyric or "·")
        found = -1
        for i in range(cursor, len(cues)):
            cue_key = _normalize_lyric_key(cues[i].text)
            if not lyric:
                if not cue_key or cue_key == "·":
                    found = i
                    break
            elif cue_key == key or key in cue_key or cue_key in key:
                found = i
                break
        if found < 0 and lyric:
            for i, cue in enumerate(cues):
                if _normalize_lyric_key(cue.text) == key:
                    found = i
                    break
        if found >= 0:
            line["start"] = cues[found].start
            line["end"] = cues[found].end
            cursor = found + 1
            if not chords:
                # Recover chord names from VTT in this window.
                recovered = []
                for cc in chords_cues or []:
                    if cc.start >= line["start"] - 0.001 and cc.start < line["end"] - 0.001:
                        parsed = _parse_chord_cue(cc)
                        if parsed["name"]:
                            recovered.append(
                                {"name": parsed["name"], "column": parsed.get("column")}
                            )
                if recovered:
                    line["chords"] = recovered
        lines.append(line)
    return lines


class OverlayRenderer:
    """Reusable overlay drawer. Call prepare() once, then render_frame() many times."""

    def __init__(
        self,
        width: int,
        height: int,
        *,
        lyric_display: str = "chart",
        show_drums: bool = True,
    ) -> None:
        self.width = int(width)
        self.height = int(height)
        # Playback and export always use the chords-and-lyrics chart scroll.
        self.lyric_display = "chart"
        self.show_drums = bool(show_drums)
        self.scale = layout_scale(self.width)
        self.band_scale = min(self.scale, 1.55)
        self.window_seconds = window_seconds_for_width(self.width)
        self._mono_path = FONTS_DIR / "IBMPlexMono-SemiBold.ttf"
        self._sans_path = FONTS_DIR / "DMSans-Medium.ttf"

        s = self.band_scale
        self.pad = max(12, int(round(14 * s)))
        self.row_gap = max(6, int(round(8 * s)))
        self.chord_h = max(44, int(round(42 * s)))
        self.lyric_h = max(56, int(round(54 * s)))
        self.drums_h = max(130, int(round(118 * s))) if self.show_drums else 0
        self.x = self.pad
        self.w = self.width - self.pad * 2
        self.playhead_w = max(2, int(round(2.5 * s)))
        self.font_size = max(22, int(round(self.lyric_h * 0.58)))
        self.stroke = max(1, min(2, int(round(self.font_size * 0.08))))
        self.hit_w = max(3.0, 2.2 * s)
        self.hit_inset = max(2.0, 2.0 * s)
        self.label_pad = max(8, int(round(10 * s)))
        self.lane_h = self.drums_h / len(DRUM_LANES) if self.drums_h else 0
        self.total_h = self.chord_h + self.row_gap + self.lyric_h + self.row_gap + self.drums_h

        # Chart scroll layout: fill everything above drums + bottom progress.
        self.progress_h = max(6, int(round(5 * s)))
        self.chart_top = self.pad
        drums_block = (self.drums_h + self.row_gap) if self.show_drums else 0
        self.chart_h = max(
            120,
            self.height - self.pad - drums_block - self.progress_h,
        )
        self.chart_drums_y = self.chart_top + self.chart_h + self.row_gap
        # Timeline band also leaves room for the bottom progress strip.
        self.band_top = self.height - self.total_h - self.pad - self.progress_h
        self.y_chord = self.band_top
        self.y_lyric = self.band_top + self.chord_h + self.row_gap
        self.y_drums = self.y_lyric + self.lyric_h + self.row_gap
        chart_chord_h = max(28, int(round(self.chart_h * 0.045)))
        chart_lyric_h = max(32, int(round(self.chart_h * 0.055)))
        self.chart_chord_h = chart_chord_h
        self.chart_lyric_h = chart_lyric_h
        self.chart_pair_gap = max(2, int(round(4 * s)))
        self.chart_block_gap = max(10, int(round(self.chart_h * 0.018)))
        self.chart_chord_font = _font(self._mono_path, max(20, int(round(chart_chord_h * 0.72))))
        self.chart_lyric_font = _font(self._mono_path, max(22, int(round(chart_lyric_h * 0.7))))

        self.mono_font = _font(self._mono_path, self.font_size)
        self.label_font = _font(self._sans_path, max(12, int(round(self.lane_h * 0.42))))
        self.segments: list[dict[str, Any]] = []
        self.lyrics_cues: list[Cue] = []
        self.sync_lines: list[dict[str, Any]] = []
        self.onsets: list[tuple[float, int, float]] = []  # time, lane_idx, strength
        self._prepared = False

    def prepare(
        self,
        lyrics_cues: list[Cue],
        chords_cues: list[Cue],
        drums_beats: dict[str, Any],
        chart_body: str = "",
    ) -> None:
        self.lyrics_cues = list(lyrics_cues or [])
        self.segments = _build_lyric_segments(self.mono_font, self.lyrics_cues, chords_cues or [])
        self.sync_lines = build_sync_lines(chart_body or "", self.lyrics_cues, chords_cues or [])
        onsets: list[tuple[float, int, float]] = []
        for onset in (drums_beats or {}).get("onsets") or []:
            try:
                t = float(onset.get("time"))
                idx = DRUM_LANES.index(onset.get("instrument"))
                strength = max(0.25, min(1.0, float(onset.get("strength") or 0.6)))
            except (TypeError, ValueError, AttributeError):
                continue
            onsets.append((t, idx, strength))
        onsets.sort(key=lambda item: item[0])
        self.onsets = onsets
        self._prepared = True

    def render_frame(self, *, current_time: float, duration: float) -> Image.Image:
        if not self._prepared:
            raise RuntimeError("OverlayRenderer.prepare() must be called before render_frame()")

        _require_pil()
        img = Image.new("RGBA", (self.width, self.height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        viewport = compute_viewport(
            current_time,
            duration,
            window_seconds=self.window_seconds,
        )

        x, w = self.x, self.w
        self._draw_chart_scroll(draw, current_time)

        if self.show_drums and self.drums_h > 0:
            drums_y = self.chart_drums_y
            # Always draw drums at full opacity — mix choice only affects audio.
            drums_img = Image.new("RGBA", (int(w), int(self.drums_h)), (0, 0, 0, 0))
            drums_draw = ImageDraw.Draw(drums_img)
            self._draw_drums(drums_draw, viewport, int(w), int(self.drums_h))
            img.paste(drums_img, (int(x), int(drums_y)), drums_img)

            playhead_x = x + w * PLAYHEAD_RATIO
            draw.line(
                [(playhead_x, drums_y), (playhead_x, drums_y + self.drums_h)],
                fill=(255, 255, 255, 217),
                width=self.playhead_w,
            )
        self._draw_progress_bar(draw, current_time, duration)
        return img

    def _draw_progress_bar(
        self,
        draw: ImageDraw.ImageDraw,
        current_time: float,
        duration: float,
    ) -> None:
        h = self.progress_h
        y = self.height - h
        d = max(0.0, float(duration or 0.0))
        t = max(0.0, float(current_time or 0.0))
        frac = min(1.0, t / d) if d > 0 else 0.0
        draw.rectangle([0, y, self.width, self.height], fill=(255, 255, 255, 46))
        if frac > 0:
            draw.rectangle(
                [0, y, int(round(self.width * frac)), self.height],
                fill=(255, 255, 255, 184),
            )
        draw.rectangle([0, y, self.width, y + 1], fill=(255, 255, 255, 31))

    def _draw_chart_scroll(self, draw: ImageDraw.ImageDraw, current_time: float) -> None:
        x, w = self.x, self.w
        y, h = self.chart_top, self.chart_h
        # Soft panel behind chart text.
        for i in range(3):
            alpha = (180, 140, 55)[i]
            y0 = y + int(h * (0 if i == 0 else 0.55 if i == 1 else 0.85))
            y1 = y + int(h * (0.55 if i == 0 else 0.85 if i == 1 else 1.0))
            draw.rectangle([x, y0, x + w, y1], fill=(10, 12, 14, alpha))

        rows: list[dict[str, Any]] = []
        for i, line in enumerate(self.sync_lines or []):
            chord_text = format_sync_chord_line(line)
            lyric_text = str(line.get("lyric") or "")
            if not chord_text and not lyric_text:
                continue
            inner = (
                (self.chart_chord_h if chord_text else 0)
                + (self.chart_lyric_h if lyric_text else 0)
                + (self.chart_pair_gap if chord_text and lyric_text else 0)
            )
            rows.append(
                {
                    "index": i,
                    "chord_text": chord_text,
                    "lyric_text": lyric_text,
                    "inner_h": inner,
                    "block_h": inner + self.chart_block_gap,
                    "start": line.get("start"),
                }
            )
        if not rows:
            return

        acc = 0.0
        for row in rows:
            row["top"] = acc
            row["mid"] = acc + row["inner_h"] / 2.0
            acc += row["block_h"]

        playing = playing_sync_line_index(self.sync_lines, current_time)
        row_idx = next((i for i, r in enumerate(rows) if r["index"] == playing), -1)
        if row_idx < 0:
            t = float(current_time or 0.0)
            fallback = 0
            for i, r in enumerate(rows):
                start = self.sync_lines[r["index"]].get("start")
                if isinstance(start, (int, float)) and t >= float(start):
                    fallback = i
            row_idx = fallback

        row0 = rows[row_idx]
        row1 = rows[row_idx + 1] if row_idx + 1 < len(rows) else None
        frac = 0.0
        if row0 and row1 and isinstance(row0.get("start"), (int, float)):
            end = sync_line_window_end(self.sync_lines, int(row0["index"]))
            start = float(row0["start"])
            if end is not None and end > start:
                frac = _smoothstep01((float(current_time) - start) / (end - start))
        focus_mid = row0["mid"] + ((row1["mid"] - row0["mid"]) * frac if row1 else 0.0)
        scroll = focus_mid - h / 2.0
        pad_x = max(12, int(round(14 * self.band_scale)))

        for row in rows:
            draw_top = y + row["top"] - scroll
            if draw_top + row["block_h"] < y - 4 or draw_top > y + h + 4:
                continue
            is_playing = row["index"] == playing
            if is_playing:
                draw.rectangle(
                    [x + 2, draw_top - 2, x + w - 2, draw_top + row["inner_h"] + 2],
                    fill=(201, 162, 39, 56),
                )
                draw.rectangle(
                    [x + 2, draw_top - 2, x + 5, draw_top + row["inner_h"] + 2],
                    fill=(240, 211, 106, 242),
                )
            ty = draw_top
            if row["chord_text"]:
                draw.text(
                    (x + pad_x, ty),
                    row["chord_text"],
                    font=self.chart_chord_font,
                    fill=(240, 211, 106, 255),
                )
                ty += self.chart_chord_h + (self.chart_pair_gap if row["lyric_text"] else 0)
            if row["lyric_text"]:
                fill = (255, 255, 255, 242) if is_playing else (245, 245, 242, 210)
                draw.text(
                    (x + pad_x, ty),
                    row["lyric_text"],
                    font=self.chart_lyric_font,
                    fill=fill,
                )

    def _stroke_text(
        self,
        draw: ImageDraw.ImageDraw,
        xy: tuple[float, float],
        text: str,
        *,
        fill: tuple[int, int, int, int],
        stroke_fill: tuple[int, int, int, int],
    ) -> None:
        x, y = xy
        s = self.stroke
        for dx, dy in ((-s, 0), (s, 0), (0, -s), (0, s), (-s, -s), (s, -s), (-s, s), (s, s)):
            draw.text((x + dx, y + dy), text, font=self.mono_font, fill=stroke_fill, anchor="lm")
        draw.text((x, y), text, font=self.mono_font, fill=fill, anchor="lm")

    def _draw_lyric_chord_band(self, draw: ImageDraw.ImageDraw, current_time: float) -> None:
        segments = self.segments
        if not segments:
            return

        x, w = self.x, self.w
        playhead_x = x + w * PLAYHEAD_RATIO
        origin_x = playhead_x - _karaoke_sing_px(segments, current_time)
        active_lyric = -1
        for i, seg in enumerate(segments):
            cue = seg["cue"]
            if current_time >= cue.start and current_time < cue.end:
                active_lyric = i
                break

        margin = self.font_size * 2
        y_chord_mid = self.y_chord + self.chord_h / 2
        y_lyric_mid = self.y_lyric + self.lyric_h / 2
        for seg in segments:
            base_x = origin_x + seg["textStartPx"]
            lyric_active = seg["index"] == active_lyric
            line_until = seg["nextStart"] if seg["nextStart"] is not None else seg["cue"].end
            line_active = current_time >= seg["cue"].start and current_time < line_until

            for chord in seg["lineChords"]:
                col = chord["column"] if isinstance(chord.get("column"), int) else 0
                px = base_x + col * seg["spaceW"]
                if px < x - margin or px > x + w + margin:
                    continue
                is_active = (
                    line_active
                    and current_time >= chord["start"]
                    and current_time < (chord["end"] or chord["start"] + 0.05)
                )
                if is_active:
                    self._stroke_text(
                        draw,
                        (px, y_chord_mid),
                        chord["name"],
                        fill=(255, 255, 255, 255),
                        stroke_fill=(0, 0, 0, 190),
                    )
                else:
                    draw.text(
                        (px, y_chord_mid),
                        chord["name"],
                        font=self.mono_font,
                        fill=(245, 240, 230, 200),
                        anchor="lm",
                    )

            if base_x < x - margin or base_x > x + w + margin:
                continue
            if lyric_active:
                self._stroke_text(
                    draw,
                    (base_x, y_lyric_mid),
                    seg["text"],
                    fill=(255, 255, 255, 255),
                    stroke_fill=(0, 0, 0, 200),
                )
            else:
                draw.text(
                    (base_x, y_lyric_mid),
                    seg["text"],
                    font=self.mono_font,
                    fill=(245, 240, 230, 165),
                    anchor="lm",
                )

    def _draw_drums(
        self,
        draw: ImageDraw.ImageDraw,
        viewport: dict[str, float],
        w: int,
        h: int,
    ) -> None:
        lane_h = self.lane_h
        draw.rectangle([0, 0, w, h], fill=(20, 24, 28, 110))
        for i, lane in enumerate(DRUM_LANES):
            ly = i * lane_h
            draw.rectangle([0, ly, w, ly + lane_h - 1], fill=(255, 255, 255, 12))
            draw.text(
                (self.label_pad, ly + lane_h / 2),
                lane,
                font=self.label_font,
                fill=(245, 240, 230, 120),
                anchor="lm",
            )
        v0, v1 = viewport["start"], viewport["end"]
        span = max(0.001, v1 - v0)
        for t, idx, strength in self.onsets:
            if t < v0 or t > v1:
                continue
            px = ((t - v0) / span) * w
            ly = idx * lane_h
            color = DRUM_COLORS.get(DRUM_LANES[idx], (136, 136, 136, 255))
            alpha = 0.55 + strength * 0.45
            draw.rectangle(
                [px - self.hit_w, ly + self.hit_inset, px + self.hit_w, ly + lane_h - self.hit_inset],
                fill=_rgba(color, alpha),
            )
