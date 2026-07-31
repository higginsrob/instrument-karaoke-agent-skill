#!/usr/bin/env python3
"""Assemble a static site under _site/ (same shape as GitHub Pages)."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.rebuild_index import rebuild_index


def build(out: Path, *, rebuild: bool = True) -> Path:
    library = ROOT / "library"
    index_html = ROOT / "index.html"
    assets = ROOT / "assets"

    if not index_html.is_file():
        raise SystemExit(f"Missing {index_html}")
    if not assets.is_dir():
        raise SystemExit(f"Missing {assets}")
    if not (library / "artists").is_dir() and not (library / "index.json").is_file():
        raise SystemExit(
            "library/ is empty. Seed with: cp -R fixtures/demo-library/. library/"
        )

    if rebuild:
        rebuild_index(library)

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    shutil.copy2(index_html, out / "index.html")
    shutil.copytree(assets, out / "assets")
    shutil.copytree(
        library,
        out / "library",
        ignore=shutil.ignore_patterns(".DS_Store", ".git", ".gitkeep"),
    )
    for junk in out.rglob(".DS_Store"):
        junk.unlink(missing_ok=True)

    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Build static instrument-karaoke site into _site/")
    parser.add_argument(
        "--out",
        type=Path,
        default=ROOT / "_site",
        help="Output directory (default: _site)",
    )
    parser.add_argument(
        "--no-index",
        action="store_true",
        help="Skip rebuilding library/index.json",
    )
    args = parser.parse_args()
    out = args.out if args.out.is_absolute() else ROOT / args.out
    built = build(out, rebuild=not args.no_index)
    song_count = "?"
    index_path = built / "library" / "index.json"
    if index_path.is_file():
        try:
            import json

            song_count = json.loads(index_path.read_text(encoding="utf-8")).get(
                "song_count", "?"
            )
        except (OSError, json.JSONDecodeError):
            pass
    print(f"Built static site → {built} ({song_count} songs)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
