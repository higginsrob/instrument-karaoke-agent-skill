#!/usr/bin/env python3
"""Fetch, parse, and save a UG tab into the local library."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.rebuild_index import rebuild_index
from scripts.slugify import slugify
from scripts.ug_fetch import fetch_url
from scripts.ug_parse import parse_html
from scripts.ug_to_markdown import to_markdown


def library_path_for(meta: dict, library_root: Path) -> Path:
    artist = slugify(meta["artist"], "unknown-artist")
    album = slugify(meta.get("album") or "singles", "singles")
    song = slugify(meta["title"], "untitled")
    return library_root / "artists" / artist / "albums" / album / f"{song}.md"


def _as_voicing_list(entry) -> list:
    if entry is None:
        return []
    if isinstance(entry, list):
        return [s for s in entry if isinstance(s, dict) and isinstance(s.get("frets"), list)]
    if isinstance(entry, dict) and isinstance(entry.get("frets"), list):
        return [entry]
    return []


def merge_shapes_into_assets(shapes: dict, assets_shapes: Path) -> None:
    if not shapes:
        return
    existing: dict = {}
    if assets_shapes.exists():
        existing = json.loads(assets_shapes.read_text(encoding="utf-8"))
    changed = False
    for name, incoming in shapes.items():
        current = _as_voicing_list(existing.get(name))
        seen = {tuple(s["frets"]) for s in current}
        merged = list(current)
        for shape in _as_voicing_list(incoming):
            key = tuple(shape["frets"])
            if key in seen:
                continue
            seen.add(key)
            merged.append(shape)
            changed = True
        if name not in existing:
            existing[name] = merged
            changed = True
        elif len(merged) != len(current) or not isinstance(existing.get(name), list):
            existing[name] = merged
            changed = True
    if changed:
        assets_shapes.parent.mkdir(parents=True, exist_ok=True)
        assets_shapes.write_text(
            json.dumps(existing, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )


def import_tab(
    url: str,
    *,
    library_root: Path | None = None,
    html: str | None = None,
    assets_shapes: Path | None = None,
    rebuild: bool = True,
) -> Path:
    library_root = library_root or (ROOT / "library")
    assets_shapes = assets_shapes or (ROOT / "assets" / "chord-shapes.json")
    page_html = html if html is not None else fetch_url(url)
    meta = parse_html(page_html, source_url=url)
    md = to_markdown(meta)
    out = library_path_for(meta, library_root)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(md, encoding="utf-8")
    merge_shapes_into_assets(meta.get("shapes") or {}, assets_shapes)
    if rebuild:
        rebuild_index(library_root)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import a UG chord tab into library/")
    parser.add_argument("url", help="Ultimate-Guitar tab URL")
    parser.add_argument(
        "--html",
        help="Use local HTML file instead of fetching (for tests / offline)",
    )
    parser.add_argument(
        "--library",
        type=Path,
        default=None,
        help="Library root (default: ./library)",
    )
    args = parser.parse_args(argv)
    html = Path(args.html).read_text(encoding="utf-8") if args.html else None
    try:
        path = import_tab(args.url, library_root=args.library, html=html)
    except Exception as exc:  # noqa: BLE001 — CLI surface
        print(f"error: {exc}", file=sys.stderr)
        return 1
    rel = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
    artist = path.parent.parent.parent.name
    album = path.parent.name
    print(f"Wrote {rel}")
    print(f"Hash: #/song/{artist}/{album}/{path.stem}")
    print("Open with: make server")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
