"""Extract lyric lines and chord→lyric pairings from UG-style chord charts."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

CHORD_TOKEN_RE = re.compile(
    r"\b([A-G](?:#|b)?(?:(?:maj|min|dim|aug|sus|add|M|m)?[0-9]*(?:[#b][0-9]+)?){0,3}"
    r"(?:\([#b0-9]+\))?(?:/[A-G](?:#|b)?)?)(?!\w)"
)
SECTION_BRACKET_RE = re.compile(r"^\[([^\]]+)\](?:\s+.*)?$")
SECTION_LOOSE_RE = re.compile(
    r"^(intro|verse|chorus|bridge|outro|solo|instrumental|interlude|pre-?chorus|"
    r"break|coda|ending|hook|refrain)(\s+\d+)?(\s*[:.\-]?\s*\d*x?)?$",
    re.I,
)
SECTION_WORD_RE = re.compile(
    r"(intro|verse|chorus|bridge|outro|solo|instrumental|interlude|pre-?chorus|"
    r"break|coda|ending|hook|refrain)",
    re.I,
)
URL_RE = re.compile(r"https?://\S+", re.I)
# e|, eb|, Bb|, Gb|, etc. followed by ASCII tab content
TAB_STRING_RE = re.compile(
    r"^(?:[eE]b?|[bB]b?|[gG]b?|[dD]b?|[aA]b?)\s*\|",
)
REPEAT_MARKER_RE = re.compile(r"\(?\s*x\d+\s*\)?", re.I)
# Parenthetical performance directions attached to chord / lyric lines
PERFORMANCE_PAREN_RE = re.compile(
    r"\((?:[^)]*\b(?:fade|repeat|barre|until|times?|continue|hold|palm\s*mute|"
    r"n\.?c\.?|no\s*chord|x\d+)[^)]*)\)",
    re.I,
)
TRAILING_REPEAT_X_RE = re.compile(r"(?i)\s+x\d+\s*$")
# Whole-line UG author / arrangement notes (not sung)
META_LINE_RE = re.compile(
    r"(?i)^(?:"
    r"please\s+rate\b.*"
    r"|tabbed\s+by\b.*"
    r"|chords?\s+used\b.*"
    r"|(?:capo|tuning|key)\s*[:.].*"
    r"|capo\s+[ivxlcd\d]+\b.*"
    r"|play\s+over\b.*"
    r"|then\s+repeat\b.*"
    r"|repeat\s+(?:verse|chorus|bridge|outro|intro|and)\b.*"
    r"|riff\s*x?\d*\b.*"
    r"|n\.?c\.?\s*$"
    r"|this\s+tab\b.*"
    r"|i\s+tabbed\b.*"
    r")$"
)
# Spoken ad-libs sometimes written in parens; keep these as lyrics.
ADLIB_PAREN_RE = re.compile(
    r"(?i)^\((?:(?:ooh+|oh+|ah+|hey+|yeah+|woo+|whoa+|mm+|uh[\s\-]?huh|ha+)"
    r"(?:[\s,/]+(?:ooh+|oh+|ah+|hey+|yeah+|woo+|whoa+|mm+|uh[\s\-]?huh|ha+))*)\)$"
)
FRET_SHAPE_RE = re.compile(r"^[xX0-9]{4,8}$")


@dataclass
class ChordToken:
    name: str
    column: int


@dataclass
class ChartLineGroup:
    """One lyric line optionally preceded by a chord-only line."""

    lyric: str
    chords: list[ChordToken]
    section: Optional[str] = None


def is_section_marker(line: str) -> bool:
    trimmed = line.strip()
    if not trimmed:
        return False
    bracket = SECTION_BRACKET_RE.match(trimmed)
    if bracket:
        inner = bracket.group(1).strip()
        if SECTION_LOOSE_RE.match(inner) or SECTION_WORD_RE.search(inner):
            return True
        # UG often uses short custom labels like [Part A]
        if 0 < len(inner) <= 40:
            return True
        return False
    return bool(SECTION_LOOSE_RE.match(trimmed))


def is_url_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    if URL_RE.fullmatch(stripped):
        return True
    # Whole line is basically just a URL (optional wrapping punctuation)
    return bool(URL_RE.search(stripped)) and len(re.sub(URL_RE, "", stripped).strip(" ()[]")) == 0


def is_tab_line(line: str) -> bool:
    """True for ASCII guitar tablature / fretboard diagrams."""
    stripped = line.strip()
    if not stripped:
        return False
    if TAB_STRING_RE.match(stripped):
        return True
    pipe_count = stripped.count("|")
    if pipe_count >= 2:
        # Chord bar lines like `| Am | G D | x3` are not tab.
        if CHORD_TOKEN_RE.search(stripped) and not re.search(r"-{3,}|\d[-|]|[|-]\d", stripped):
            return False
        # Heavy dash/digit/pipe texture ⇒ tablature
        tabish = len(re.findall(r"[-|0-9hpxHPX/~]", stripped))
        if tabish >= max(8, int(0.5 * len(stripped))):
            return True
        rest = re.sub(r"[|\-\s0-9hpxHPX/~.=]+", "", stripped, flags=re.I)
        rest = REPEAT_MARKER_RE.sub("", rest).strip()
        if len(rest) <= 2:
            return True
    return False


def is_fret_diagram_line(line: str) -> bool:
    """True for bare fret dumps like 'x02220' or 'xx0222 x02120 x24232'."""
    stripped = line.strip().rstrip(",;")
    if not stripped:
        return False
    tokens = [t.strip(",;") for t in stripped.split() if t.strip(",;")]
    if not tokens:
        return False
    return all(FRET_SHAPE_RE.match(t) for t in tokens)


def is_parenthetical_note(line: str) -> bool:
    """Whole-line (...) performance / arrangement notes, not sung ad-libs."""
    stripped = line.strip()
    if not (stripped.startswith("(") and stripped.endswith(")") and len(stripped) >= 3):
        return False
    if ADLIB_PAREN_RE.match(stripped):
        return False
    return True


def is_meta_line(line: str) -> bool:
    """UG author notes, capo/tuning headers, arrangement instructions."""
    stripped = line.strip()
    if not stripped:
        return False
    if META_LINE_RE.match(stripped):
        return True
    if is_parenthetical_note(stripped):
        return True
    if is_fret_diagram_line(stripped):
        return True
    if re.search(r"(?i)\b(?:standard\s+tuning|re-?tuning|barre\s+chord|this\s+version)\b", stripped):
        return True
    if re.search(r"(?i)\bplease\s+rate\b", stripped):
        return True
    # Short "…tab…" commentary from UG authors
    if re.search(r"(?i)\btab\b", stripped) and len(stripped) < 80:
        if not re.search(r"(?i)\b(table|tablet|taboo)\b", stripped):
            return True
    return False


def is_chord_only_line(line: str) -> bool:
    stripped = line.strip()
    if (
        not stripped
        or is_section_marker(stripped)
        or is_url_line(stripped)
        or is_tab_line(stripped)
        or is_meta_line(stripped)
    ):
        return False
    remainder = CHORD_TOKEN_RE.sub("", stripped)
    remainder = REPEAT_MARKER_RE.sub("", remainder)
    remainder = PERFORMANCE_PAREN_RE.sub("", remainder)
    remainder = re.sub(r"[\s|/.\-#(),]+", "", remainder)
    if remainder:
        return False
    return bool(CHORD_TOKEN_RE.search(stripped))


def extract_chord_tokens(line: str) -> list[ChordToken]:
    tokens: list[ChordToken] = []
    for match in CHORD_TOKEN_RE.finditer(line):
        tokens.append(ChordToken(name=match.group(1), column=match.start()))
    return tokens


def _normalize_lyric(text: str) -> str:
    text = URL_RE.sub("", text)
    text = PERFORMANCE_PAREN_RE.sub("", text)
    text = TRAILING_REPEAT_X_RE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip(" \t|-")
    return text.strip()


def looks_like_lyric_core(lyric: str) -> bool:
    """Structural checks shared by lyric acceptance (no meta filter)."""
    if not lyric:
        return False
    words = re.findall(r"[A-Za-z']{2,}", lyric)
    if not words:
        return False
    letters = sum(ch.isalpha() for ch in lyric)
    if letters < 3:
        return False
    glyphs = sum(ch in "|-_=+" for ch in lyric)
    if glyphs >= max(3, letters):
        return False
    return True


def looks_like_lyric_text(text: str) -> bool:
    """Reject leftover tab junk / markers / commentary after chord stripping."""
    lyric = _normalize_lyric(text)
    if not lyric or is_section_marker(lyric) or is_url_line(lyric) or is_tab_line(lyric):
        return False
    if is_meta_line(lyric) or is_fret_diagram_line(lyric) or is_parenthetical_note(lyric):
        return False
    return looks_like_lyric_core(lyric)


def _strip_preamble(lines: list[str]) -> list[str]:
    """Drop commentary before the first section marker when sections exist."""
    for i, line in enumerate(lines):
        if is_section_marker(line.strip()):
            return lines[i:]
    return lines


def extract_chart_groups(chart_body: str) -> list[ChartLineGroup]:
    """
    Parse chart body into lyric groups with optional chord tokens.

    Chord-only lines attach to the following lyric line. Standalone chord lines
    without a following lyric become lyric-less groups (instrumental).
    Non-lyric noise (URLs, ASCII tabs, section labels, preamble) is skipped.
    """
    lines = _strip_preamble(_body_lines(chart_body))
    groups: list[ChartLineGroup] = []
    pending_chords: list[ChordToken] = []
    current_section: Optional[str] = None

    def flush_pending() -> None:
        nonlocal pending_chords
        if pending_chords:
            groups.append(
                ChartLineGroup(lyric="", chords=pending_chords, section=current_section)
            )
            pending_chords = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            flush_pending()
            continue
        if is_section_marker(stripped):
            flush_pending()
            current_section = stripped
            continue
        if is_url_line(stripped) or is_tab_line(line) or is_meta_line(stripped) or is_fret_diagram_line(stripped):
            flush_pending()
            continue
        if is_chord_only_line(line):
            flush_pending()
            pending_chords = extract_chord_tokens(line)
            continue
        # Lyric (or mixed) line
        chords = pending_chords or extract_chord_tokens(line)
        if pending_chords:
            lyric = _normalize_lyric(stripped)
        else:
            lyric = _normalize_lyric(CHORD_TOKEN_RE.sub("", line))
        if not looks_like_lyric_text(lyric):
            # Chord tokens on a junk line still count as instrumental material.
            if chords and not pending_chords:
                flush_pending()
                groups.append(ChartLineGroup(lyric="", chords=chords, section=current_section))
            elif pending_chords:
                flush_pending()
            continue
        groups.append(ChartLineGroup(lyric=lyric, chords=chords, section=current_section))
        pending_chords = []

    flush_pending()
    return groups


def _body_lines(chart_body: str) -> list[str]:
    text = str(chart_body or "").replace("\r\n", "\n").replace("\r", "\n")
    return text.split("\n")


def lyric_texts_for_align(groups: list[ChartLineGroup]) -> list[str]:
    return [g.lyric for g in groups if g.lyric.strip() and looks_like_lyric_text(g.lyric)]
