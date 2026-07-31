#!/usr/bin/env python3
"""Serve the static _site build with no admin or API routes."""

from __future__ import annotations

import argparse
import functools
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]


class StaticHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".json": "application/json",
        ".md": "text/markdown; charset=utf-8",
        ".js": "application/javascript",
        ".css": "text/css",
        ".vtt": "text/vtt; charset=utf-8",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".mp4": "video/mp4",
        ".mid": "audio/midi",
        ".midi": "audio/midi",
    }

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:
        if urlparse(self.path).path.startswith("/api/"):
            self.send_error(404, "Not Found")
            return
        super().do_GET()

    def do_PUT(self) -> None:
        self.send_error(404, "Not Found")

    def do_POST(self) -> None:
        self.send_error(404, "Not Found")

    def do_DELETE(self) -> None:
        self.send_error(404, "Not Found")

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve static instrument-karaoke _site/ (no admin)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument(
        "--root",
        type=Path,
        default=ROOT / "_site",
        help="Directory to serve (default: _site)",
    )
    args = parser.parse_args()
    root = args.root if args.root.is_absolute() else ROOT / args.root
    if not root.is_dir() or not (root / "index.html").is_file():
        raise SystemExit(f"Missing static build at {root}. Run: make build")

    handler = functools.partial(StaticHandler, directory=str(root.resolve()))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving {root.resolve()} at http://{args.host}:{args.port}/ (static, no admin)")
    print("Press Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
