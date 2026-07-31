#!/usr/bin/env python3
"""Fetch an Ultimate-Guitar tab page HTML."""

from __future__ import annotations

import argparse
import sys
import urllib.error
import urllib.request
from pathlib import Path

USER_AGENT = (
    "Mozilla/5.0 (compatible; instrument-karaoke-import/1.0; +https://github.com/higginsrob/instrument-karaoke-agent-skill)"
)


def fetch_url(url: str, timeout: float = 30.0) -> str:
    if not url.startswith(("http://", "https://")):
        raise ValueError(f"Invalid URL: {url}")
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(charset, errors="replace")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch UG tab HTML")
    parser.add_argument("url", help="Ultimate-Guitar tab URL")
    parser.add_argument("-o", "--output", help="Write HTML to file instead of stdout")
    args = parser.parse_args(argv)
    try:
        html = fetch_url(args.url)
    except (urllib.error.URLError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if args.output:
        Path(args.output).write_text(html, encoding="utf-8")
    else:
        sys.stdout.write(html)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
