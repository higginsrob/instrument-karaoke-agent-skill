from __future__ import annotations

import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.vtt_validate import (  # noqa: E402
    Cue,
    parse_vtt,
    validate_kind_content,
    validate_media_vtt,
    validate_vtt_pair_text,
)


class TestVttValidate(unittest.TestCase):
    def test_out_of_order_lyrics_are_errors(self) -> None:
        lyrics = [
            Cue(110.0, 117.0, "Down in a hole, losing my soul"),
            Cue(200.0, 200.05, "I'd like to fly,"),
            Cue(122.0, 135.0, "But my wings have been so denied"),
        ]
        chords = [Cue(110.0, 111.0, "Dm|0"), Cue(111.0, 112.0, "C|15")]
        result = validate_media_vtt(lyrics, chords)
        self.assertFalse(result["ok"])
        self.assertTrue(any("chronological" in e for e in result["errors"]))

    def test_short_orphan_lyric_warns(self) -> None:
        lyrics = [
            Cue(1.0, 2.0, "Hello"),
            Cue(3.0, 3.05, "Tiny"),
            Cue(4.0, 5.0, "World"),
        ]
        result = validate_media_vtt(lyrics, [])
        self.assertTrue(result["ok"])
        self.assertTrue(any("very short" in w for w in result["warnings"]))

    def test_chord_format_required(self) -> None:
        result = validate_kind_content("chords", "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nDm\n")
        self.assertFalse(result["ok"])
        self.assertTrue(any("Name|column" in e for e in result["errors"]))

    def test_valid_pair_ok(self) -> None:
        lyrics = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHello\n\n2\n00:00:03.000 --> 00:00:04.000\nWorld\n"
        chords = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:01.500\nAm|0\n\n2\n00:00:03.000 --> 00:00:03.500\nG|2\n"
        result = validate_vtt_pair_text(lyrics, chords)
        self.assertTrue(result["ok"])
        self.assertEqual(result["warnings"], [])
        self.assertEqual(len(parse_vtt(lyrics)), 2)

    def test_down_in_a_hole_fixed_file(self) -> None:
        path = (
            ROOT
            / "library/artists/alice-in-chains/albums/singles/down-in-a-hole/lyrics.vtt"
        )
        if not path.is_file():
            self.skipTest("song media not present")
        chords_path = path.with_name("chords.vtt")
        result = validate_vtt_pair_text(
            path.read_text(encoding="utf-8"),
            chords_path.read_text(encoding="utf-8") if chords_path.is_file() else "WEBVTT\n",
        )
        self.assertTrue(result["ok"], result)
        self.assertFalse(any("chronological" in e for e in result["errors"]))


if __name__ == "__main__":
    unittest.main()
