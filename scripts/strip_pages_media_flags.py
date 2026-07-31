#!/usr/bin/env python3
"""Clear media fields in library/index.json for charts-only GitHub Pages publishes."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "index",
        type=Path,
        help="Path to library/index.json",
    )
    args = parser.parse_args()
    data = json.loads(args.index.read_text(encoding="utf-8"))
    songs = data.get("songs") or []
    for song in songs:
        song["media_status"] = "none"
        song["media_downloaded"] = False
        song["media_processed"] = False
        song["media_playable"] = False
        song["youtube_url"] = ""
    args.index.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Cleared media flags for {len(songs)} songs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
