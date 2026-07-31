"""Unit tests for STT↔chart lyric join (no Whisper model download)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PIPELINE = ROOT / "services" / "media-pipeline"
if str(PIPELINE) not in sys.path:
    sys.path.insert(0, str(PIPELINE))

from server.services.force_align import (  # noqa: E402
    join_stt_words_to_lines,
    normalize_token,
    tokenize_lyric,
)


def _words(pairs: list[tuple[str, float, float]]):
    """Build STT word dicts from (word, start, end)."""
    return [{"word": w, "start": s, "end": e} for w, s, e in pairs]


class TestNormalizeToken(unittest.TestCase):
    def test_lowercase_and_punct(self) -> None:
        self.assertEqual(normalize_token("Hello,"), "hello")
        self.assertEqual(normalize_token("Don't"), "dont")
        self.assertEqual(normalize_token("  YEAH!!! "), "yeah")

    def test_empty(self) -> None:
        self.assertEqual(normalize_token(""), "")
        self.assertEqual(normalize_token("..."), "")


class TestTokenizeLyric(unittest.TestCase):
    def test_basic(self) -> None:
        self.assertEqual(tokenize_lyric("Down in a hole"), ["down", "in", "a", "hole"])

    def test_punct(self) -> None:
        self.assertEqual(tokenize_lyric("Bury me softly,"), ["bury", "me", "softly"])


class TestJoinSttWordsToLines(unittest.TestCase):
    def test_exact_match_times(self) -> None:
        lines = ["Down in a hole", "feeling so small"]
        words = _words(
            [
                ("Down", 1.0, 1.2),
                ("in", 1.2, 1.4),
                ("a", 1.4, 1.5),
                ("hole", 1.5, 2.0),
                ("feeling", 3.0, 3.4),
                ("so", 3.4, 3.6),
                ("small", 3.6, 4.0),
            ]
        )
        cues = join_stt_words_to_lines(lines, words)
        self.assertIsNotNone(cues)
        assert cues is not None
        self.assertEqual(len(cues), 2)
        self.assertEqual(cues[0][2], "Down in a hole")
        self.assertEqual(cues[1][2], "feeling so small")
        self.assertAlmostEqual(cues[0][0], 1.0, places=2)
        self.assertAlmostEqual(cues[0][1], 2.0, places=2)
        self.assertAlmostEqual(cues[1][0], 3.0, places=2)
        self.assertAlmostEqual(cues[1][1], 4.0, places=2)

    def test_extra_stt_filler_still_maps(self) -> None:
        lines = ["hello world", "goodbye friend"]
        words = _words(
            [
                ("yeah", 0.0, 0.3),
                ("ooh", 0.3, 0.5),
                ("hello", 1.0, 1.3),
                ("world", 1.3, 1.8),
                ("uh", 2.0, 2.2),
                ("goodbye", 3.0, 3.5),
                ("friend", 3.5, 4.0),
                ("yeah", 4.2, 4.5),
            ]
        )
        cues = join_stt_words_to_lines(lines, words)
        self.assertIsNotNone(cues)
        assert cues is not None
        self.assertEqual(cues[0][2], "hello world")
        self.assertAlmostEqual(cues[0][0], 1.0, places=2)
        self.assertAlmostEqual(cues[0][1], 1.8, places=2)
        self.assertAlmostEqual(cues[1][0], 3.0, places=2)
        self.assertAlmostEqual(cues[1][1], 4.0, places=2)

    def test_missing_chart_word_still_maps_line(self) -> None:
        # STT drops "a"; line should still get times from remaining matches.
        lines = ["down in a hole"]
        words = _words(
            [
                ("down", 1.0, 1.2),
                ("in", 1.2, 1.4),
                ("hole", 1.6, 2.0),
            ]
        )
        cues = join_stt_words_to_lines(lines, words)
        self.assertIsNotNone(cues)
        assert cues is not None
        self.assertEqual(len(cues), 1)
        self.assertEqual(cues[0][2], "down in a hole")
        self.assertAlmostEqual(cues[0][0], 1.0, places=2)
        self.assertAlmostEqual(cues[0][1], 2.0, places=2)

    def test_low_coverage_returns_none(self) -> None:
        lines = [
            "one two three four",
            "five six seven eight",
            "nine ten eleven twelve",
            "thirteen fourteen fifteen sixteen",
        ]
        # Only one line worth of matching words → coverage 25% < 50%.
        words = _words(
            [
                ("one", 0.0, 0.2),
                ("two", 0.2, 0.4),
                ("three", 0.4, 0.6),
                ("four", 0.6, 0.8),
                ("zzz", 1.0, 1.2),
                ("yyy", 1.2, 1.4),
            ]
        )
        cues = join_stt_words_to_lines(lines, words, min_coverage=0.5)
        self.assertIsNone(cues)

    def test_empty_stt_returns_none(self) -> None:
        self.assertIsNone(join_stt_words_to_lines(["hello"], []))

    def test_chart_text_preserved_not_stt(self) -> None:
        lines = ["Bury me softly"]
        words = _words(
            [
                ("berry", 1.0, 1.3),  # mismatch on first token
                ("me", 1.3, 1.5),
                ("softly", 1.5, 2.0),
            ]
        )
        cues = join_stt_words_to_lines(lines, words)
        self.assertIsNotNone(cues)
        assert cues is not None
        self.assertEqual(cues[0][2], "Bury me softly")


if __name__ == "__main__":
    unittest.main()
