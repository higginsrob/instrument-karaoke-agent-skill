"""Unit and smoke tests for UG import pipeline (stdlib unittest)."""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
import sys

sys.path.insert(0, str(ROOT))

from scripts.frontmatter import dump_frontmatter, load_frontmatter
from scripts.rebuild_index import media_flags_for_song, rebuild_index
from scripts.slugify import slugify
from scripts.ug_import import import_tab
from scripts.ug_parse import parse_html
from scripts.ug_to_markdown import clean_ug_content, to_markdown

FIXTURE_HTML = ROOT / "fixtures" / "beck-country-down.html"
EXPECTED_MD = ROOT / "fixtures" / "beck-country-down.expected.md"
DEMO_LIB = ROOT / "fixtures" / "demo-library"
SOURCE_URL = "https://tabs.ultimate-guitar.com/tab/beck/country-down-chords-1466425"


class TestSlugify(unittest.TestCase):
    def test_basic(self) -> None:
        self.assertEqual(slugify("Beck"), "beck")
        self.assertEqual(slugify("Country Down"), "country-down")
        self.assertEqual(slugify(""), "unknown")


class TestFrontmatter(unittest.TestCase):
    def test_roundtrip(self) -> None:
        data = {
            "title": "Country Down",
            "capo": 0,
            "key": None,
            "source_id": "1466425",
            "scroll_speed": 0.75,
            "chords": ["G", "C/B", "Am"],
        }
        loaded = load_frontmatter(dump_frontmatter(data))
        self.assertEqual(loaded["title"], "Country Down")
        self.assertEqual(loaded["capo"], 0)
        self.assertIsNone(loaded["key"])
        self.assertEqual(loaded["source_id"], "1466425")
        self.assertEqual(loaded["scroll_speed"], 0.75)
        self.assertEqual(loaded["chords"], ["G", "C/B", "Am"])


class TestParseAndConvert(unittest.TestCase):
    def test_parse_fixture(self) -> None:
        html = FIXTURE_HTML.read_text(encoding="utf-8")
        meta = parse_html(html, source_url=SOURCE_URL)
        self.assertEqual(meta["title"], "Country Down")
        self.assertEqual(meta["artist"], "Beck")
        self.assertEqual(meta["tuning"], "E A D G B E")
        self.assertEqual(meta["source_id"], "1466425")
        self.assertIn("G", meta["chords"])
        self.assertIn("C/B", meta["chords"])
        self.assertIn("[Intro]", meta["content_raw"])

    def test_clean_strips_tags(self) -> None:
        raw = "[tab][ch]G[/ch]  [ch]C[/ch]\nHello\u00a0world[/tab]\nX\n"
        cleaned = clean_ug_content(raw)
        self.assertNotIn("[ch]", cleaned)
        self.assertNotIn("[tab]", cleaned)
        self.assertIn("G  C", cleaned)
        self.assertIn("Hello world", cleaned)
        self.assertNotRegex(cleaned, r"(?m)^X$")

    def test_clean_spaces_above_chord_lines(self) -> None:
        raw = (
            "[Verse]\n"
            "G     C\n"
            "hello there\n"
            "Am    D\n"
            "more lyrics\n"
        )
        cleaned = clean_ug_content(raw)
        self.assertIn("[Verse]\n\nG     C\nhello there\n\nAm    D\nmore lyrics\n", cleaned)

    def test_complex_chords_get_spacing(self) -> None:
        raw = (
            "[Chorus]\n"
            "Bm7add11                A\n"
            "It wears her out\n"
            "Dmaj9/F#   E6        Dsus2\n"
            "For her fake plant\n"
        )
        cleaned = clean_ug_content(raw)
        self.assertIn("[Chorus]\n\nBm7add11                A\n", cleaned)
        self.assertIn("It wears her out\n\nDmaj9/F#   E6        Dsus2\n", cleaned)

    def test_to_markdown_matches_fixture(self) -> None:
        html = FIXTURE_HTML.read_text(encoding="utf-8")
        meta = parse_html(html, source_url=SOURCE_URL)
        meta["album"] = "singles"
        meta["difficulty"] = meta.get("difficulty") or "intermediate"
        md = to_markdown(meta, imported_at="2026-07-30")
        expected = EXPECTED_MD.read_text(encoding="utf-8")
        self.assertEqual(md, expected)


class TestImportAndIndex(unittest.TestCase):
    def test_import_writes_library(self) -> None:
        html = FIXTURE_HTML.read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            lib = Path(tmp) / "library"
            shapes = Path(tmp) / "chord-shapes.json"
            path = import_tab(
                SOURCE_URL,
                library_root=lib,
                html=html,
                assets_shapes=shapes,
            )
            self.assertTrue(path.exists())
            text = path.read_text(encoding="utf-8")
            self.assertIn("title: Country Down", text)
            self.assertIn("```", text)
            index = json.loads((lib / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(index["song_count"], 1)
            self.assertEqual(index["songs"][0]["title"], "Country Down")
            self.assertTrue(shapes.exists())
            # UG stores frets high→low; import should reverse to low→high
            stored = json.loads(shapes.read_text(encoding="utf-8"))
            self.assertEqual(stored["C"][0]["frets"], [-1, 3, 2, 0, 1, 0])
            self.assertEqual(stored["G"][0]["frets"], [3, 2, 0, 0, 0, 3])
            self.assertEqual(stored["F"][0]["frets"], [1, 3, 3, 2, 1, 1])

    def test_rebuild_demo_library(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lib = Path(tmp) / "library"
            shutil.copytree(DEMO_LIB, lib)
            index = rebuild_index(lib)
            self.assertGreaterEqual(index["song_count"], 1)
            self.assertTrue((lib / "index.json").exists())
            artists = {a["slug"] for a in index["artists"]}
            self.assertIn("beck", artists)

    def test_media_flags_from_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            song = Path(tmp) / "artists" / "a" / "albums" / "singles" / "s.md"
            song.parent.mkdir(parents=True)
            song.write_text(
                "---\ntitle: S\nartist: A\nalbum: singles\nmedia_status: processing\n---\n\n```\nx\n```\n",
                encoding="utf-8",
            )
            media = song.with_suffix("")
            media.mkdir()
            (media / "source.mp3").write_bytes(b"x")
            flags = media_flags_for_song(song, {"media_status": "processing"})
            self.assertTrue(flags["media_downloaded"])
            self.assertFalse(flags["media_processed"])
            (media / "lyrics.vtt").write_text("WEBVTT\n", encoding="utf-8")
            flags = media_flags_for_song(song, {"media_status": "needs_review"})
            self.assertTrue(flags["media_downloaded"])
            self.assertTrue(flags["media_processed"])
            self.assertTrue(flags["media_playable"])
            index = rebuild_index(Path(tmp))
            entry = index["songs"][0]
            self.assertTrue(entry["media_downloaded"])
            self.assertTrue(entry["media_processed"])
            self.assertTrue(entry["media_playable"])
            self.assertEqual(entry["media_status"], "processing")
            # Without audio files, ready status is still not playable on a static site.
            song2 = Path(tmp) / "artists" / "a" / "albums" / "singles" / "t.md"
            song2.write_text(
                "---\ntitle: T\nartist: A\nalbum: singles\nmedia_status: ready\n---\n\n```\nx\n```\n",
                encoding="utf-8",
            )
            flags2 = media_flags_for_song(song2, {"media_status": "ready"})
            self.assertFalse(flags2["media_playable"])

    def test_sync_song_media_flags_patches_stale_index(self) -> None:
        from scripts.rebuild_index import sync_song_media_flags

        with tempfile.TemporaryDirectory() as tmp:
            lib = Path(tmp)
            song = lib / "artists" / "a" / "albums" / "singles" / "s.md"
            song.parent.mkdir(parents=True)
            song.write_text(
                "---\ntitle: S\nartist: A\nalbum: singles\nmedia_status: needs_review\n---\n\n```\nx\n```\n",
                encoding="utf-8",
            )
            media = song.with_suffix("")
            media.mkdir()
            (media / "source.mp3").write_bytes(b"x")
            (media / "mixes").mkdir()
            (media / "mixes" / "original.mp3").write_bytes(b"x")
            # Stale index as left when the job was only queued.
            (lib / "index.json").write_text(
                json.dumps(
                    {
                        "song_count": 1,
                        "artists": [],
                        "songs": [
                            {
                                "title": "S",
                                "path": "artists/a/albums/singles/s.md",
                                "media_status": "queued",
                                "media_downloaded": False,
                                "media_processed": False,
                                "media_playable": False,
                                "youtube_url": "",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            flags = media_flags_for_song(song, {"media_status": "needs_review"})
            self.assertTrue(sync_song_media_flags(lib, "artists/a/albums/singles/s.md", flags))
            entry = json.loads((lib / "index.json").read_text(encoding="utf-8"))["songs"][0]
            self.assertEqual(entry["media_status"], "needs_review")
            self.assertTrue(entry["media_playable"])
            self.assertFalse(sync_song_media_flags(lib, "artists/a/albums/singles/s.md", flags))


class TestSmokeSiteFiles(unittest.TestCase):
    def test_site_assets_exist(self) -> None:
        for rel in (
            "index.html",
            "assets/styles.css",
            "assets/app.js",
            "assets/markdown.js",
            "assets/chords.js",
            "assets/chord-shapes.json",
            "assets/queue.js",
            "assets/media-player.js",
            "assets/media-analysis.js",
            "services/media-pipeline/server/main.py",
            "services/media-pipeline/Dockerfile",
            "services/media-pipeline/Dockerfile.gpu",
            "services/media-pipeline/docker-compose.yml",
        ):
            self.assertTrue((ROOT / rel).is_file(), f"missing {rel}")


class TestAdminServeHelpers(unittest.TestCase):
    def test_resolve_rejects_escape(self) -> None:
        from scripts.serve import _resolve_library_song_path

        with self.assertRaises(ValueError):
            _resolve_library_song_path("../secrets.md")
        with self.assertRaises(ValueError):
            _resolve_library_song_path("artists/../../etc/passwd.md")

    def test_normalize_meta_clamps_scroll_speed(self) -> None:
        from scripts.serve import _normalize_meta

        meta = _normalize_meta(
            {
                "title": "X",
                "artist": "Y",
                "scroll_speed": 9,
                "chords": "Am, G, D",
            }
        )
        self.assertEqual(meta["scroll_speed"], 4.0)
        self.assertEqual(meta["chords"], ["Am", "G", "D"])
        self.assertEqual(meta["start_delay"], 0.0)

    def test_normalize_meta_clamps_start_delay(self) -> None:
        from scripts.serve import _normalize_meta

        meta = _normalize_meta(
            {
                "title": "X",
                "artist": "Y",
                "start_delay": 99,
                "chords": [],
            }
        )
        self.assertEqual(meta["start_delay"], 30.0)

        meta_neg = _normalize_meta(
            {
                "title": "X",
                "artist": "Y",
                "start_delay": -3,
                "chords": [],
            }
        )
        self.assertEqual(meta_neg["start_delay"], 0.0)

    def test_cleanup_empty_parents(self) -> None:
        from scripts import serve as serve_mod

        with tempfile.TemporaryDirectory() as tmp:
            lib = Path(tmp) / "library"
            song = lib / "artists" / "beck" / "albums" / "singles" / "country-down.md"
            song.parent.mkdir(parents=True)
            song.write_text("x", encoding="utf-8")
            old_library = serve_mod.LIBRARY
            serve_mod.LIBRARY = lib
            try:
                song.unlink()
                serve_mod._cleanup_empty_parents(song)
                self.assertFalse((lib / "artists" / "beck").exists())
            finally:
                serve_mod.LIBRARY = old_library

    def test_to_song_markdown_includes_scroll_speed(self) -> None:
        from scripts.serve import _normalize_meta, _to_song_markdown

        meta = _normalize_meta(
            {
                "title": "Down In A Hole",
                "artist": "Alice In Chains",
                "scroll_speed": 0.75,
                "start_delay": 3,
                "chords": ["Am"],
            }
        )
        md = _to_song_markdown(meta, "Am\nhello\n")
        self.assertIn("scroll_speed: 0.75", md)
        self.assertIn("start_delay: 3.0", md)
        self.assertIn("```\nAm\nhello\n```", md)

    def test_normalize_meta_youtube_and_media_status(self) -> None:
        from scripts.serve import _normalize_meta

        meta = _normalize_meta(
            {
                "title": "X",
                "artist": "Y",
                "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                "media_status": "needs_review",
                "chords": [],
            }
        )
        self.assertEqual(meta["youtube_url"], "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        self.assertEqual(meta["media_status"], "needs_review")
        self.assertIsNone(meta["media_verified_at"])

    def test_should_enqueue_on_new_url(self) -> None:
        from scripts.serve import _should_enqueue

        self.assertTrue(
            _should_enqueue(
                {"youtube_url": "https://youtu.be/aaaaaaaaaaa", "media_status": "none"},
                {"youtube_url": "", "media_status": "none"},
            )
        )
        self.assertFalse(
            _should_enqueue(
                {"youtube_url": "https://youtu.be/aaaaaaaaaaa", "media_status": "ready"},
                {"youtube_url": "https://youtu.be/aaaaaaaaaaa", "media_status": "ready"},
            )
        )
        self.assertTrue(
            _should_enqueue(
                {"youtube_url": "https://youtu.be/bbbbbbbbbbb", "media_status": "ready"},
                {"youtube_url": "https://youtu.be/aaaaaaaaaaa", "media_status": "ready"},
            )
        )

    def test_force_enqueue_ready_song(self) -> None:
        from scripts.serve import _maybe_enqueue_media
        from unittest.mock import patch

        meta = {
            "youtube_url": "https://youtu.be/aaaaaaaaaaa",
            "media_status": "ready",
            "title": "T",
            "artist": "A",
        }
        with patch("scripts.serve._media_request") as mock_req:
            mock_req.return_value = (200, b'{"id":"abc123","status":"queued"}', "application/json")
            skipped = _maybe_enqueue_media("artists/a/albums/b/c.md", meta, "body", meta, force=False)
            self.assertFalse(skipped.get("enqueued"))
            self.assertEqual(skipped.get("reason"), "not_needed")

            forced = _maybe_enqueue_media("artists/a/albums/b/c.md", meta, "body", meta, force=True)
            self.assertTrue(forced.get("enqueued"))
            mock_req.assert_called()


class TestChartExtract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        sys.path.insert(0, str(ROOT / "services" / "media-pipeline"))

    def test_pairs_chords_with_lyrics(self) -> None:
        from server.services.chart_extract import extract_chart_groups, lyric_texts_for_align

        body = "[Verse]\n\nG     C\nhello there\n\nAm    D\nmore lyrics\n"
        groups = extract_chart_groups(body)
        lyrics = lyric_texts_for_align(groups)
        self.assertEqual(lyrics, ["hello there", "more lyrics"])
        self.assertEqual([c.name for c in groups[0].chords], ["G", "C"])
        self.assertEqual([c.name for c in groups[1].chords], ["Am", "D"])

    def test_section_and_chord_only(self) -> None:
        from server.services.chart_extract import extract_chart_groups

        body = "[Intro]\n\nG  C  D\n\n[Verse]\nAm\nwords\n"
        groups = extract_chart_groups(body)
        self.assertTrue(any(g.lyric == "" and [c.name for c in g.chords] == ["G", "C", "D"] for g in groups))
        lyric_groups = [g for g in groups if g.lyric]
        self.assertEqual(lyric_groups[0].lyric, "words")
        self.assertEqual([c.name for c in lyric_groups[0].chords], ["Am"])

    def test_skips_tabs_urls_and_preamble(self) -> None:
        from server.services.chart_extract import extract_chart_groups, lyric_texts_for_align

        body = """
Acoustic Version from MTV Unplugged:
https://www.youtube.com/watch?v=nWK0kqjPSVI

[Intro] (repeat for verse)

eb|-----------------|-3-----2---------|
Bb|-0h1-------1-----|---3-------3-----|
Gb|-----2-------2---|-----0-------2---| x4
Db|-------2-------2-|-------0-------0-|
Ab|-0-------0-------|-----------------|
Eb|-----------------|-3---------------|

[Verse 1]

Am      G      D       Am    G  D
Bury me softly in this womb

Am          G       D      Am   G  D
I give this part of me for you

[Outro]
| Am      | G  D    | x3
"""
        lyrics = lyric_texts_for_align(extract_chart_groups(body))
        self.assertEqual(
            lyrics,
            [
                "Bury me softly in this womb",
                "I give this part of me for you",
            ],
        )
        joined = "\n".join(lyrics)
        self.assertNotIn("http", joined)
        self.assertNotIn("|-", joined)
        self.assertNotIn("Acoustic", joined)
        self.assertNotIn("Intro", joined)

    def test_skips_commentary_performance_notes_and_frets(self) -> None:
        from server.services.chart_extract import extract_chart_groups, lyric_texts_for_align

        body = """
I just saw them play this live. Please rate!

Intro: D  Cadd9

Verse:

D
Palmtrees and fun, fabulous sun

D   Cadd9   D   Cadd9  (repeat until fade out)

A             G
    Now I'm a fool

xx0222 x02120 x24232
Capo II
Play over Chorus
(ooh)
G
To please myself
Am
Hearts and thoughts they fade, fade away (3x fade out)
Please rate!
"""
        lyrics = lyric_texts_for_align(extract_chart_groups(body))
        self.assertEqual(
            lyrics,
            [
                "Palmtrees and fun, fabulous sun",
                "Now I'm a fool",
                "(ooh)",
                "To please myself",
                "Hearts and thoughts they fade, fade away",
            ],
        )
        joined = "\n".join(lyrics)
        self.assertNotIn("Please rate", joined)
        self.assertNotIn("fade out", joined)
        self.assertNotIn("Capo", joined)
        self.assertNotIn("xx0222", joined)
        self.assertNotIn("Play over", joined)


if __name__ == "__main__":
    unittest.main()
