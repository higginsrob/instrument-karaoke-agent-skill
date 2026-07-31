from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PIPELINE = ROOT / "services" / "media-pipeline"
if str(PIPELINE) not in sys.path:
    sys.path.insert(0, str(PIPELINE))

from server.services.export_overlays import (  # noqa: E402
    parse_vtt,
    window_seconds_for_width,
)
from server.services.export_video import audible_stems, resolve_export_audio  # noqa: E402
from server.services.mix_renderer import (  # noqa: E402
    MIX_DEFINITIONS,
    discover_stem_names,
    drums_silent_for_mix,
    stem_mix_id,
)


class TestExportHelpers(unittest.TestCase):
    def test_window_scales_with_width(self) -> None:
        # Wider exports use a longer time window so drums don't race vs the ~900px preview.
        self.assertGreater(window_seconds_for_width(1920), window_seconds_for_width(900))
        self.assertGreaterEqual(window_seconds_for_width(1920), 16.0)

    def test_parse_vtt(self) -> None:
        cues = parse_vtt(
            "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHello\n\n2\n00:00:03.000 --> 00:00:04.000\nWorld\n"
        )
        self.assertEqual(len(cues), 2)
        self.assertEqual(cues[0].text, "Hello")
        self.assertAlmostEqual(cues[0].start, 1.0)
        self.assertAlmostEqual(cues[0].end, 2.5)

    def test_audible_stems_mute_and_solo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stems = Path(tmp)
            for name in ("vocals", "bass", "drums"):
                (stems / f"{name}.wav").write_bytes(b"RIFF")
            muted = audible_stems(stems, {"drums": True}, {})
            self.assertEqual([p.stem for p in muted], ["vocals", "bass"])
            soloed = audible_stems(stems, {}, {"bass": True})
            self.assertEqual([p.stem for p in soloed], ["bass"])
            # muted wins over solo
            both = audible_stems(stems, {"bass": True}, {"bass": True})
            self.assertEqual(both, [])

    def test_mix_definitions(self) -> None:
        self.assertEqual(set(MIX_DEFINITIONS), {
            "original",
            "karaoke-vocals",
            "karaoke-bass",
            "karaoke-other",
            "karaoke-drums",
        })
        self.assertIsNone(MIX_DEFINITIONS["original"])
        self.assertEqual(MIX_DEFINITIONS["karaoke-vocals"], ("drums", "bass", "other"))
        self.assertEqual(MIX_DEFINITIONS["karaoke-other"], ("vocals", "drums", "bass"))
        self.assertTrue(drums_silent_for_mix("karaoke-drums"))
        self.assertFalse(drums_silent_for_mix("original"))
        self.assertEqual(stem_mix_id("vocals"), "stem-vocals")

    def test_discover_stem_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stems = Path(tmp)
            for name in ("other.wav", "vocals.wav", "guitar.wav", "drums.wav"):
                (stems / name).write_bytes(b"RIFF")
            self.assertEqual(discover_stem_names(stems), ["vocals", "drums", "guitar", "other"])

    def test_resolve_export_audio_prefers_prerendered(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            media_dir = Path(tmp)
            mixes = media_dir / "mixes"
            mixes.mkdir()
            target = mixes / "karaoke-vocals.mp3"
            target.write_bytes(b"ID3")
            with tempfile.TemporaryDirectory() as tmp2:
                resolved = resolve_export_audio(
                    media_dir=media_dir,
                    mix_id="karaoke-vocals",
                    duration=1.0,
                    tmp_dir=Path(tmp2),
                )
            self.assertEqual(resolved, target)


if __name__ == "__main__":
    unittest.main()
