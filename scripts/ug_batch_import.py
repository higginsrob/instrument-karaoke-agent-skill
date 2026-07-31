#!/usr/bin/env python3
"""Batch-import Ultimate-Guitar chord tab URLs into the local library."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.rebuild_index import rebuild_index
from scripts.ug_import import import_tab

SOURCE_ID_RE = re.compile(r"-(\d+)/?$")


def source_id_from_url(url: str) -> str | None:
    cleaned = re.sub(r"[?#].*$", "", url.strip())
    match = SOURCE_ID_RE.search(cleaned)
    return match.group(1) if match else None


def load_urls(path: Path) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        url = line.strip()
        if not url or url.startswith("#"):
            continue
        url = re.sub(r"[?#].*$", "", url)
        if url in seen:
            continue
        seen.add(url)
        urls.append(url)
    return urls


def existing_source_ids(library_root: Path) -> set[str]:
    index_path = library_root / "index.json"
    if not index_path.exists():
        return set()
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    ids: set[str] = set()
    for song in index.get("songs") or []:
        sid = str(song.get("source_id") or "").strip()
        if sid:
            ids.add(sid)
        source = str(song.get("source") or "").strip()
        from_source = source_id_from_url(source)
        if from_source:
            ids.add(from_source)
    return ids


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Batch import UG chord tabs from a URL list")
    parser.add_argument(
        "urls_file",
        type=Path,
        help="Text file with one tabs.ultimate-guitar.com URL per line",
    )
    parser.add_argument(
        "--library",
        type=Path,
        default=None,
        help="Library root (default: ./library)",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=1.5,
        help="Seconds to wait between fetches (default: 1.5)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Import at most N new tabs (0 = all)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List what would be imported without fetching",
    )
    args = parser.parse_args(argv)

    library_root = args.library or (ROOT / "library")
    urls = load_urls(args.urls_file)
    if not urls:
        print(f"error: no URLs found in {args.urls_file}", file=sys.stderr)
        return 1

    known = existing_source_ids(library_root)
    todo: list[str] = []
    skipped = 0
    for url in urls:
        sid = source_id_from_url(url)
        if sid and sid in known:
            skipped += 1
            continue
        todo.append(url)

    if args.limit and args.limit > 0:
        todo = todo[: args.limit]

    print(f"URLs in file: {len(urls)}")
    print(f"Already imported: {skipped}")
    print(f"To import: {len(todo)}")
    if args.dry_run:
        for url in todo:
            print(f"  would import {url}")
        return 0

    ok = 0
    failed: list[tuple[str, str]] = []
    for i, url in enumerate(todo, start=1):
        print(f"[{i}/{len(todo)}] {url}", flush=True)
        try:
            path = import_tab(url, library_root=library_root, rebuild=False)
            rel = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
            print(f"  wrote {rel}", flush=True)
            ok += 1
            sid = source_id_from_url(url)
            if sid:
                known.add(sid)
        except Exception as exc:  # noqa: BLE001 — keep batch going
            print(f"  error: {exc}", file=sys.stderr, flush=True)
            failed.append((url, str(exc)))
        if i < len(todo) and args.delay > 0:
            time.sleep(args.delay)

    index = rebuild_index(library_root)
    print(f"Done. imported={ok} failed={len(failed)} skipped={skipped} library={index['song_count']}")
    if failed:
        fail_path = ROOT / "tmp" / "mytabs-import-failures.txt"
        fail_path.parent.mkdir(parents=True, exist_ok=True)
        fail_path.write_text(
            "\n".join(f"{url}\t{err}" for url, err in failed) + "\n",
            encoding="utf-8",
        )
        print(f"Failures written to {fail_path}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
