"""Force-align chart lyrics to vocals and derive chord VTT cues."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Optional

from server.services.chart_extract import extract_chart_groups, lyric_texts_for_align, looks_like_lyric_text

logger = logging.getLogger(__name__)

# Minimum fraction of chart lines that must match STT words to accept STT timing.
_STT_MIN_COVERAGE = 0.5
_MIN_CUE_DUR = 0.08

_TOKEN_RE = re.compile(r"[a-z0-9']+")


def _format_vtt_time(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds % 60
    return f"{hours:02d}:{minutes:02d}:{secs:06.3f}"


def write_vtt(cues: list[tuple[float, float, str]], path: Path) -> None:
    lines = ["WEBVTT", ""]
    for index, (start, end, text) in enumerate(cues, start=1):
        if end <= start:
            end = start + 0.05
        lines.append(str(index))
        lines.append(f"{_format_vtt_time(start)} --> {_format_vtt_time(end)}")
        lines.append(text)
        lines.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def normalize_token(token: str) -> str:
    """Lowercase token with punctuation stripped for STT↔chart matching."""
    raw = (token or "").strip().lower()
    if not raw:
        return ""
    # Keep apostrophes inside words (don't → dont after strip of other punct).
    cleaned = re.sub(r"[^\w']+", "", raw, flags=re.UNICODE)
    cleaned = cleaned.replace("'", "")
    return cleaned


def tokenize_lyric(text: str) -> list[str]:
    """Split a lyric line into normalized tokens."""
    return [t for t in (_TOKEN_RE.findall((text or "").lower())) if t]


def _load_mono(path: Path, sr: int = 16000):
    import librosa
    import numpy as np

    y, rate = librosa.load(str(path), sr=sr, mono=True)
    return np.asarray(y, dtype=np.float32), int(rate)


def _vocal_phrases(
    y,
    sr: int,
    *,
    min_dur: float = 1.0,
    merge_gap: float = 0.4,
) -> list[tuple[float, float]]:
    """
    Detect sung phrases from vocals-stem RMS.

    Drops short bursts and leading low-energy bleed (common Demucs leakage
    before the first real lyric line).
    """
    import librosa
    import numpy as np

    if y.size == 0:
        return []

    hop = 512
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    if rms.size == 0:
        return []
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)
    noise = float(np.percentile(rms, 40))
    peak = float(np.percentile(rms, 90))
    threshold = noise + max(0.0, peak - noise) * 0.35
    active = rms > max(threshold, 1e-4)

    raw: list[list[int]] = []
    start_i: Optional[int] = None
    for i, on in enumerate(active):
        if on and start_i is None:
            start_i = i
        elif not on and start_i is not None:
            raw.append([start_i, i])
            start_i = None
    if start_i is not None:
        raw.append([start_i, len(active)])

    merged: list[list[int]] = []
    for a, b in raw:
        if not merged:
            merged.append([a, b])
            continue
        gap = float(times[a] - times[min(merged[-1][1], len(times) - 1)])
        if gap <= merge_gap:
            merged[-1][1] = b
        else:
            merged.append([a, b])

    phrases: list[tuple[float, float, float]] = []
    for a, b in merged:
        t0 = float(times[a])
        t1 = float(times[min(b, len(times) - 1)])
        if t1 - t0 < min_dur:
            continue
        mean_e = float(np.mean(rms[a:b])) if b > a else 0.0
        phrases.append((t0, t1, mean_e))

    if not phrases:
        duration = float(len(y) / sr) if sr else 0.0
        return [(0.0, duration)] if duration > 0 else []

    # Drop leading bleed that is much quieter than later singing.
    if len(phrases) >= 2:
        rest = [e for _, _, e in phrases[1:]]
        rest_med = float(np.median(rest)) if rest else phrases[0][2]
        while len(phrases) >= 2 and phrases[0][2] < rest_med * 0.55:
            phrases = phrases[1:]

    return [(t0, t1) for t0, t1, _ in phrases]


def _match_texts_to_phrases(
    texts: list[str],
    phrases: list[tuple[float, float]],
) -> list[tuple[float, float, str]]:
    """Map lyric lines onto detected vocal phrases (split/merge as needed)."""
    if not texts:
        return []
    if not phrases:
        return []

    spans = list(phrases)
    # Merge shortest gaps until phrase count <= lyric count
    while len(spans) > len(texts) and len(spans) >= 2:
        gap_idx = min(range(len(spans) - 1), key=lambda i: spans[i + 1][0] - spans[i][1])
        a0, _ = spans[gap_idx]
        _, b1 = spans[gap_idx + 1]
        spans = spans[:gap_idx] + [(a0, b1)] + spans[gap_idx + 2 :]

    # Split longest phrases until counts match
    while len(spans) < len(texts):
        idx = max(range(len(spans)), key=lambda i: spans[i][1] - spans[i][0])
        a, b = spans[idx]
        mid = (a + b) / 2.0
        if b - a < 0.2:
            break
        spans = spans[:idx] + [(a, mid), (mid, b)] + spans[idx + 1 :]

    cues: list[tuple[float, float, str]] = []
    if len(spans) == len(texts):
        for (a, b), text in zip(spans, texts):
            cues.append((a, max(b, a + _MIN_CUE_DUR), text))
        return cues

    # Fallback: proportional inside first→last phrase window
    v_start = spans[0][0]
    v_end = spans[-1][1]
    weights = [max(1, len(t.split())) for t in texts]
    total_w = sum(weights) or 1
    cursor = v_start
    span = max(0.1, v_end - v_start)
    for text, weight in zip(texts, weights):
        length = span * (weight / total_w)
        start = cursor
        end = min(v_end, cursor + length)
        cues.append((start, max(end, start + _MIN_CUE_DUR), text))
        cursor = end
    if cues:
        last = cues[-1]
        cues[-1] = (last[0], max(last[1], v_end), last[2])
    return cues


def join_stt_words_to_lines(
    chart_lines: list[str],
    stt_words: list,
    *,
    min_coverage: float = _STT_MIN_COVERAGE,
) -> Optional[list[tuple[float, float, str]]]:
    """
    Sequence-align STT words onto chart lyric lines.

    Returns cues with chart text and STT-derived times, or None when coverage
    is too low (caller should fall back to energy alignment).

    ``stt_words`` items need ``.start``, ``.end``, ``.word`` attributes (or
    dict keys with the same names).
    """
    if not chart_lines:
        return []
    if not stt_words:
        return None

    def _word_fields(w) -> tuple[float, float, str]:
        if isinstance(w, dict):
            return float(w["start"]), float(w["end"]), str(w["word"])
        return float(w.start), float(w.end), str(w.word)

    stt_norm: list[tuple[float, float, str]] = []
    for w in stt_words:
        start, end, raw = _word_fields(w)
        tok = normalize_token(raw)
        if tok:
            stt_norm.append((start, max(end, start + 0.02), tok))

    if not stt_norm:
        return None

    # Flatten chart tokens with line index.
    chart_toks: list[tuple[int, str]] = []
    line_token_counts = [0] * len(chart_lines)
    for li, line in enumerate(chart_lines):
        toks = tokenize_lyric(line)
        line_token_counts[li] = len(toks)
        for tok in toks:
            chart_toks.append((li, tok))

    if not chart_toks:
        # Empty token lines — cannot STT-join meaningfully.
        return None

    m = len(chart_toks)
    n = len(stt_norm)
    # Costs: match=0 if equal else 1; skip STT=0.4 (ad-libs); skip chart=2.0
    MATCH_EQ = 0.0
    MATCH_NE = 1.0
    SKIP_STT = 0.4
    SKIP_CHART = 2.0

    # dp[i][j] = best cost aligning first i chart toks to first j STT words
    # Use flat arrays for memory; predecessors for traceback.
    INF = 1e18
    dp = [[INF] * (n + 1) for _ in range(m + 1)]
    # prev[i][j] = (pi, pj, kind) where kind in ("match", "skip_stt", "skip_chart")
    prev: list[list[Optional[tuple[int, int, str]]]] = [[None] * (n + 1) for _ in range(m + 1)]
    dp[0][0] = 0.0
    for j in range(1, n + 1):
        dp[0][j] = dp[0][j - 1] + SKIP_STT
        prev[0][j] = (0, j - 1, "skip_stt")
    for i in range(1, m + 1):
        dp[i][0] = dp[i - 1][0] + SKIP_CHART
        prev[i][0] = (i - 1, 0, "skip_chart")

    for i in range(1, m + 1):
        _, ctok = chart_toks[i - 1]
        for j in range(1, n + 1):
            _, _, stok = stt_norm[j - 1]
            # match / substitute
            cost_m = dp[i - 1][j - 1] + (MATCH_EQ if ctok == stok else MATCH_NE)
            best = cost_m
            best_prev = (i - 1, j - 1, "match")
            # skip STT word
            cost_s = dp[i][j - 1] + SKIP_STT
            if cost_s < best:
                best = cost_s
                best_prev = (i, j - 1, "skip_stt")
            # skip chart token
            cost_c = dp[i - 1][j] + SKIP_CHART
            if cost_c < best:
                best = cost_c
                best_prev = (i - 1, j, "skip_chart")
            dp[i][j] = best
            prev[i][j] = best_prev

    # Traceback: collect STT word indices matched to each chart line (exact only).
    line_word_idxs: list[list[int]] = [[] for _ in range(len(chart_lines))]
    i, j = m, n
    while i > 0 or j > 0:
        step = prev[i][j]
        if step is None:
            break
        pi, pj, kind = step
        if kind == "match":
            ctok = chart_toks[i - 1][1]
            stok = stt_norm[j - 1][2]
            if ctok == stok:
                line_idx = chart_toks[i - 1][0]
                line_word_idxs[line_idx].append(j - 1)
        i, j = pi, pj

    for idxs in line_word_idxs:
        idxs.reverse()

    matched = sum(1 for idxs in line_word_idxs if idxs)
    lines_with_tokens = sum(1 for c in line_token_counts if c > 0)
    coverage = matched / max(1, lines_with_tokens)
    if coverage < min_coverage:
        logger.info(
            "STT join coverage %.0f%% below threshold %.0f%%; rejecting",
            coverage * 100,
            min_coverage * 100,
        )
        return None

    # Build timed cues for matched lines; leave None for unmatched.
    timed: list[Optional[tuple[float, float]]] = [None] * len(chart_lines)
    for li, idxs in enumerate(line_word_idxs):
        if not idxs:
            continue
        start = stt_norm[idxs[0]][0]
        end = stt_norm[idxs[-1]][1]
        timed[li] = (start, max(end, start + _MIN_CUE_DUR))

    # Interpolate unmatched lines between neighbors.
    for li in range(len(chart_lines)):
        if timed[li] is not None:
            continue
        prev_i = next((k for k in range(li - 1, -1, -1) if timed[k] is not None), None)
        next_i = next((k for k in range(li + 1, len(chart_lines)) if timed[k] is not None), None)
        if prev_i is not None and next_i is not None:
            gap_start = timed[prev_i][1]
            gap_end = timed[next_i][0]
            between = [k for k in range(prev_i + 1, next_i) if timed[k] is None]
            if not between:
                continue
            # Fill all between in one go.
            span = max(0.05 * len(between), gap_end - gap_start)
            if gap_end < gap_start:
                gap_end = gap_start + span
                span = gap_end - gap_start
            step = span / len(between)
            for bi, k in enumerate(between):
                a = gap_start + bi * step
                b = gap_start + (bi + 1) * step
                timed[k] = (a, max(b, a + _MIN_CUE_DUR))

    # Fill leading / trailing unmatched with short steps from nearest neighbor.
    first_matched = next((k for k, t in enumerate(timed) if t is not None), None)
    if first_matched is not None and first_matched > 0:
        t0 = timed[first_matched][0]
        step = 0.5
        for k in range(first_matched - 1, -1, -1):
            end = t0 - (first_matched - 1 - k) * step
            start = end - step
            timed[k] = (max(0.0, start), max(end, start + _MIN_CUE_DUR))

    last_matched = next((k for k in range(len(timed) - 1, -1, -1) if timed[k] is not None), None)
    if last_matched is not None:
        for k in range(last_matched + 1, len(timed)):
            if timed[k] is not None:
                continue
            prev_end = timed[k - 1][1] if timed[k - 1] else 0.0
            timed[k] = (prev_end, prev_end + 0.5)

    # Any remaining holes: interpolate again or reject.
    if any(t is None for t in timed):
        for li in range(len(timed)):
            if timed[li] is not None:
                continue
            prev_i = next((k for k in range(li - 1, -1, -1) if timed[k] is not None), None)
            next_i = next((k for k in range(li + 1, len(timed)) if timed[k] is not None), None)
            if prev_i is not None and next_i is not None:
                a = timed[prev_i][1]
                b = timed[next_i][0]
                mid0 = a
                mid1 = max(b, a + _MIN_CUE_DUR)
                timed[li] = (mid0, mid1)
            else:
                return None

    cues: list[tuple[float, float, str]] = []
    for li, line in enumerate(chart_lines):
        start, end = timed[li]  # type: ignore[misc]
        # Ensure non-decreasing starts.
        if cues and start < cues[-1][0]:
            start = cues[-1][0]
        if end <= start:
            end = start + _MIN_CUE_DUR
        cues.append((start, end, line))

    # Soft-enforce monotonic ends: each cue ends before or at next start when possible.
    for i in range(len(cues) - 1):
        s0, e0, t0 = cues[i]
        s1, e1, t1 = cues[i + 1]
        if e0 > s1 and s1 > s0:
            cues[i] = (s0, s1, t0)

    return cues


def _align_with_stt(
    vocals_path: Path,
    texts: list[str],
    device: str,
    hypothesis_vtt_path: Optional[Path] = None,
) -> Optional[list[tuple[float, float, str]]]:
    """STT word timestamps → join onto chart lines. Returns None on failure."""
    try:
        from server.services.vocal_stt import transcribe_vocals
    except ImportError:
        logger.info("faster-whisper unavailable; skipping STT alignment")
        return None

    try:
        words, segments = transcribe_vocals(vocals_path, device=device)
    except Exception:
        logger.exception("STT transcription failed; falling back to energy alignment")
        return None

    if hypothesis_vtt_path is not None and segments:
        write_vtt(
            [(s.start, max(s.end, s.start + 0.05), s.text) for s in segments],
            hypothesis_vtt_path,
        )

    if not words:
        logger.info("STT returned no words; falling back to energy alignment")
        return None

    cues = join_stt_words_to_lines(texts, words)
    if cues is None:
        return None
    return cues


def align_chart_to_vtt(
    *,
    chart_body: str,
    vocals_path: Path,
    lyrics_vtt_path: Path,
    chords_vtt_path: Path,
    device: str = "cpu",
    stt_hypothesis_vtt_path: Optional[Path] = None,
) -> dict:
    groups = extract_chart_groups(chart_body)
    texts = lyric_texts_for_align(groups)

    if not vocals_path.is_file():
        raise FileNotFoundError(f"Missing vocals stem: {vocals_path}")

    cues: list[tuple[float, float, str]] = []
    method = "none"
    wrote_hypothesis = False

    if texts:
        hyp_path = stt_hypothesis_vtt_path
        if hyp_path is None:
            hyp_path = lyrics_vtt_path.parent / "stt_hypothesis.vtt"
        stt_cues = _align_with_stt(vocals_path, texts, device=device, hypothesis_vtt_path=hyp_path)
        if stt_cues:
            cues = stt_cues
            method = "stt"
            wrote_hypothesis = hyp_path.is_file()
            logger.info("Aligned %d lyric lines via STT join", len(cues))
        else:
            y, sr = _load_mono(vocals_path)
            phrases = _vocal_phrases(y, sr)
            cues = _match_texts_to_phrases(texts, phrases)
            method = "energy"
            logger.info("Aligned %d lyric lines via energy phrases", len(cues))

    write_vtt([(s, e, t) for s, e, t in cues], lyrics_vtt_path)

    # Map lyric cues back onto groups for chord timing
    chord_cues: list[tuple[float, float, str]] = []
    cue_by_text_index = 0
    for group in groups:
        has_lyric = bool(group.lyric.strip()) and looks_like_lyric_text(group.lyric)
        if not has_lyric:
            # instrumental chord-only: place short cues evenly if we have duration
            if group.chords and cues:
                prev_end = chord_cues[-1][1] if chord_cues else (cues[0][0] if cues else 0.0)
                step = 0.5
                for i, chord in enumerate(group.chords):
                    start = prev_end + i * step
                    chord_cues.append((start, start + step, f"{chord.name}|{max(0, int(chord.column))}"))
            continue
        if cue_by_text_index >= len(cues):
            break
        start, end, _ = cues[cue_by_text_index]
        cue_by_text_index += 1
        if not group.chords:
            continue
        span = max(0.05, end - start)
        cols = [max(0, int(c.column)) for c in group.chords]
        max_col = max(len(group.lyric), max(cols) if cols else 0, 1)
        for i, chord in enumerate(group.chords):
            p0 = cols[i] / max_col
            p1 = cols[i + 1] / max_col if i + 1 < len(cols) else 1.0
            if p1 <= p0:
                p1 = min(1.0, p0 + 1.0 / max(len(group.chords), 1))
            c_start = start + span * p0
            c_end = start + span * p1
            chord_cues.append(
                (c_start, max(c_end, c_start + 0.05), f"{chord.name}|{cols[i]}")
            )

    write_vtt(chord_cues, chords_vtt_path)
    result: dict = {
        "lyrics_cues": len(cues),
        "chords_cues": len(chord_cues),
        "groups": len(groups),
        "method": method,
    }
    if wrote_hypothesis:
        result["stt_hypothesis"] = "stt_hypothesis.vtt"
    return result
