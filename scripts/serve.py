#!/usr/bin/env python3
"""Local static file server with admin write API for the chord library site."""

from __future__ import annotations

import argparse
import functools
import json
import mimetypes
import os
import re
import shutil
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.frontmatter import dump_frontmatter, load_frontmatter
from scripts.rebuild_index import media_flags_for_song, rebuild_index, sync_song_media_flags
from scripts.vtt_validate import validate_kind_content, validate_vtt_pair_text

LIBRARY = ROOT / "library"
MEDIA_API_URL = os.environ.get("MEDIA_API_URL", "http://127.0.0.1:8093").rstrip("/")
MEDIA_STATUSES = frozenset(
    {"none", "queued", "processing", "needs_review", "ready", "failed"}
)
ACTIVE_MEDIA = frozenset({"queued", "processing", "needs_review", "ready"})


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class QuietHandler(SimpleHTTPRequestHandler):
    # Fail stuck media transfers quickly after the browser aborts on refresh.
    timeout = 8
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

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/status":
            media_ok = False
            try:
                media_ok = _media_request("GET", "/healthz")[0] == 200
            except Exception:
                media_ok = False
            self._json_response(
                200,
                {"admin": True, "media_api": MEDIA_API_URL, "media_reachable": media_ok},
            )
            return
        if path == "/api/queue":
            self._proxy_media(
                "GET",
                f"/v1/jobs?{parsed.query}" if parsed.query else "/v1/jobs",
                timeout=5,
            )
            return
        if path.startswith("/api/queue/"):
            job_id = path[len("/api/queue/") :].strip("/")
            if not job_id or "/" in job_id:
                self._json_response(400, {"error": "Invalid job id"})
                return
            self._proxy_media("GET", f"/v1/jobs/{job_id}", timeout=5)
            return
        if path == "/api/media":
            self._handle_get_media(parsed)
            return
        if path == "/api/media/file":
            self._handle_get_media_file(parsed)
            return
        super().do_GET()

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/song":
            self._handle_put_song()
            return
        if parsed.path == "/api/media/vtt":
            self._handle_put_vtt()
            return
        self.send_error(404, "Not Found")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/media/verify":
            self._handle_verify_media()
            return
        if parsed.path == "/api/media/export":
            self._handle_export_media()
            return
        if parsed.path == "/api/media/reprocess":
            self._handle_reprocess_media()
            return
        if parsed.path == "/api/queue/pause":
            self._proxy_media("POST", "/v1/queue/pause")
            return
        if parsed.path == "/api/queue/resume":
            self._proxy_media("POST", "/v1/queue/resume")
            return
        if parsed.path == "/api/queue/clear-complete":
            self._proxy_media("POST", "/v1/queue/clear-complete")
            return
        if parsed.path == "/api/queue/clear":
            self._proxy_media("POST", "/v1/queue/clear")
            return
        self.send_error(404, "Not Found")

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/song":
            self._handle_delete_song()
            return
        if parsed.path.startswith("/api/queue/"):
            job_id = parsed.path[len("/api/queue/") :].strip("/")
            if not job_id or "/" in job_id:
                self._json_response(400, {"error": "Invalid job id"})
                return
            self._proxy_media("DELETE", f"/v1/jobs/{job_id}")
            return
        self.send_error(404, "Not Found")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _read_json_body(self) -> dict[str, Any] | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json_response(400, {"error": "Invalid Content-Length"})
            return None
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as err:
            self._json_response(400, {"error": f"Invalid JSON: {err}"})
            return None
        if not isinstance(payload, dict):
            self._json_response(400, {"error": "Expected JSON object"})
            return None
        return payload

    def _proxy_media(
        self,
        method: str,
        media_path: str,
        body: bytes | None = None,
        *,
        timeout: float = 30,
    ) -> None:
        try:
            status, data, content_type = _media_request(
                method, media_path, body=body, timeout=timeout
            )
        except urllib.error.URLError as err:
            self._json_response(502, {"error": f"Media API unreachable: {err.reason}"})
            return
        except TimeoutError:
            self._json_response(504, {"error": "Media API timed out"})
            return
        except Exception as err:
            self._json_response(502, {"error": f"Media API error: {err}"})
            return
        self.send_response(status)
        self.send_header("Content-Type", content_type or "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _handle_put_song(self) -> None:
        payload = self._read_json_body()
        if payload is None:
            return

        path_rel = payload.get("path")
        meta = payload.get("meta")
        body = payload.get("body")
        if not isinstance(path_rel, str) or not isinstance(meta, dict) or not isinstance(body, str):
            self._json_response(400, {"error": "Expected path (str), meta (object), body (str)"})
            return

        try:
            target = _resolve_library_song_path(path_rel)
        except ValueError as err:
            self._json_response(400, {"error": str(err)})
            return

        if not target.exists():
            self._json_response(404, {"error": f"Song not found: {path_rel}"})
            return

        prev_meta: dict[str, Any] = {}
        try:
            prev_raw = target.read_text(encoding="utf-8")
            prev_meta, _ = _split_song_markdown(prev_raw)
        except Exception:
            prev_meta = {}

        cleaned_meta = _normalize_meta(meta)
        enqueue_info = _maybe_enqueue_media(path_rel, cleaned_meta, body, prev_meta)
        if enqueue_info.get("enqueued"):
            cleaned_meta["media_status"] = "queued"
            cleaned_meta["media_verified_at"] = None
        elif enqueue_info.get("error") and cleaned_meta.get("youtube_url"):
            # Keep prior status unless we attempted and failed hard with no prior active job
            if cleaned_meta.get("media_status") in (None, "", "none"):
                cleaned_meta["media_status"] = "failed"

        md = _to_song_markdown(cleaned_meta, body)
        try:
            target.write_text(md, encoding="utf-8")
            index = rebuild_index(LIBRARY)
        except OSError as err:
            self._json_response(500, {"error": f"Write failed: {err}"})
            return

        self._json_response(
            200,
            {
                "ok": True,
                "path": path_rel,
                "song_count": index["song_count"],
                "media": enqueue_info,
                "meta": {
                    "youtube_url": cleaned_meta.get("youtube_url") or "",
                    "media_status": cleaned_meta.get("media_status") or "none",
                },
            },
        )

    def _handle_delete_song(self) -> None:
        payload = self._read_json_body()
        if payload is None:
            return

        path_rel = payload.get("path")
        if not isinstance(path_rel, str):
            self._json_response(400, {"error": "Expected path (str)"})
            return

        try:
            target = _resolve_library_song_path(path_rel)
        except ValueError as err:
            self._json_response(400, {"error": str(err)})
            return

        if not target.exists():
            self._json_response(404, {"error": f"Song not found: {path_rel}"})
            return

        media_dir = _media_dir_for_song(target)
        try:
            target.unlink()
            if media_dir.is_dir():
                shutil.rmtree(media_dir, ignore_errors=True)
            _cleanup_empty_parents(target)
            index = rebuild_index(LIBRARY)
        except OSError as err:
            self._json_response(500, {"error": f"Delete failed: {err}"})
            return

        self._json_response(
            200,
            {
                "ok": True,
                "path": path_rel,
                "song_count": index["song_count"],
            },
        )

    def _handle_get_media(self, parsed) -> None:
        qs = parse_qs(parsed.query)
        path_rel = (qs.get("path") or [""])[0]
        if not path_rel:
            self._json_response(400, {"error": "Expected path query param"})
            return
        try:
            target = _resolve_library_song_path(path_rel)
        except ValueError as err:
            self._json_response(400, {"error": str(err)})
            return
        if not target.exists():
            self._json_response(404, {"error": "Song not found"})
            return
        media_dir = _media_dir_for_song(target)
        media_json = {}
        if (media_dir / "media.json").is_file():
            try:
                media_json = json.loads((media_dir / "media.json").read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                media_json = {}
        meta, _ = _split_song_markdown(target.read_text(encoding="utf-8"))
        files = {}
        for name in (
            "source.mp3",
            "lyrics.vtt",
            "chords.vtt",
            "drums_beats.json",
            "drums.mid",
            "media.json",
        ):
            if (media_dir / name).is_file():
                files[name] = True
        youtube_dir = media_dir / "youtube"
        if youtube_dir.is_dir():
            for child in youtube_dir.iterdir():
                if child.is_file():
                    files[f"youtube/{child.name}"] = True
        stems_dir = media_dir / "stems"
        if stems_dir.is_dir():
            for child in stems_dir.iterdir():
                if child.is_file():
                    files[f"stems/{child.name}"] = True
        mixes_dir = media_dir / "mixes"
        if mixes_dir.is_dir():
            for child in mixes_dir.iterdir():
                if child.is_file():
                    files[f"mixes/{child.name}"] = True
        exports_dir = media_dir / "exports"
        if exports_dir.is_dir():
            for child in exports_dir.iterdir():
                if child.is_file():
                    files[f"exports/{child.name}"] = True
        export_status = None
        export_status_path = media_dir / "exports" / "status.json"
        if export_status_path.is_file():
            try:
                export_status = json.loads(export_status_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                export_status = None
        media_status = meta.get("media_status") or media_json.get("status") or "none"
        flags = media_flags_for_song(target, meta)
        # Pipeline updates frontmatter/files without rebuilding index.json; keep
        # media_playable in sync so the Video view switch appears after processing.
        try:
            sync_song_media_flags(LIBRARY, path_rel, flags)
        except OSError:
            pass
        self._json_response(
            200,
            {
                "path": path_rel,
                "media_status": media_status,
                "youtube_url": meta.get("youtube_url") or media_json.get("youtube_url") or "",
                "media_verified_at": meta.get("media_verified_at"),
                "media_downloaded": flags["media_downloaded"],
                "media_processed": flags["media_processed"],
                "media_playable": flags["media_playable"],
                "media": media_json,
                "export": export_status,
                "files": files,
                "media_base": str(media_dir.relative_to(LIBRARY)) if media_dir.exists() else None,
            },
        )

    def _handle_get_media_file(self, parsed) -> None:
        qs = parse_qs(parsed.query)
        path_rel = (qs.get("path") or [""])[0]
        rel_file = (qs.get("file") or [""])[0]
        if not path_rel or not rel_file:
            self._json_response(400, {"error": "Expected path and file query params"})
            return
        try:
            target = _resolve_library_song_path(path_rel)
            file_path = _resolve_media_file(target, rel_file)
        except ValueError as err:
            self._json_response(400, {"error": str(err)})
            return
        if not file_path.is_file():
            self._json_response(404, {"error": "File not found"})
            return
        ctype = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        if file_path.suffix.lower() == ".vtt":
            ctype = "text/vtt; charset=utf-8"
        file_size = file_path.stat().st_size
        range_header = self.headers.get("Range")
        start = 0
        end = file_size - 1
        status = 200
        if range_header and file_size > 0:
            match = re.match(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match:
                self.send_error(416, "Requested Range Not Satisfiable")
                return
            start_s, end_s = match.group(1), match.group(2)
            try:
                start = int(start_s) if start_s else 0
                end = int(end_s) if end_s else file_size - 1
            except ValueError:
                self.send_error(416, "Requested Range Not Satisfiable")
                return
            if start >= file_size or start < 0 or end < start:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.end_headers()
                return
            end = min(end, file_size - 1)
            status = 206
        length = max(0, end - start + 1) if file_size else 0
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.send_header("Access-Control-Allow-Origin", "*")
        # Avoid holding the browser's per-host connection slots across refresh.
        self.send_header("Connection", "close")
        self.end_headers()
        if length <= 0:
            return
        # Class timeout (8s) is for idle/stuck request handlers after abort.
        # Stem/video bodies are tens of MB; with 6 concurrent <audio> Range
        # reads the socket can block >8s and would otherwise truncate the
        # response → browser net::ERR_CONTENT_LENGTH_MISMATCH.
        prev_timeout = self.connection.gettimeout()
        try:
            self.connection.settimeout(None)
            with file_path.open("rb") as handle:
                handle.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = handle.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            # Client navigated away / refreshed — stop pushing stem/video bytes.
            return
        finally:
            try:
                self.connection.settimeout(prev_timeout)
            except OSError:
                pass

    def _handle_put_vtt(self) -> None:
        payload = self._read_json_body()
        if payload is None:
            return
        path_rel = payload.get("path")
        kind = payload.get("kind")
        content = payload.get("content")
        if not isinstance(path_rel, str) or kind not in ("lyrics", "chords") or not isinstance(content, str):
            self._json_response(400, {"error": "Expected path, kind (lyrics|chords), content"})
            return
        validation = validate_kind_content(kind, content)
        if not validation["ok"]:
            self._json_response(
                400,
                {
                    "error": validation["errors"][0] if validation["errors"] else "Invalid VTT",
                    "validation": validation,
                },
            )
            return
        try:
            target = _resolve_library_song_path(path_rel)
            file_path = _resolve_media_file(target, f"{kind}.vtt")
        except ValueError as err:
            self._json_response(400, {"error": str(err)})
            return
        if not target.exists():
            self._json_response(404, {"error": "Song not found"})
            return
        # Cross-check pair when the sibling track already exists on disk.
        media_dir = _media_dir_for_song(target)
        other_kind = "chords" if kind == "lyrics" else "lyrics"
        other_path = media_dir / f"{other_kind}.vtt"
        if other_path.is_file():
            try:
                other_text = other_path.read_text(encoding="utf-8")
            except OSError:
                other_text = "WEBVTT\n"
            lyrics_text = content if kind == "lyrics" else other_text
            chords_text = content if kind == "chords" else other_text
            pair = validate_vtt_pair_text(lyrics_text, chords_text)
            if not pair["ok"]:
                self._json_response(
                    400,
                    {
                        "error": pair["errors"][0] if pair["errors"] else "Invalid VTT pair",
                        "validation": pair,
                    },
                )
                return
        try:
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(content, encoding="utf-8")
        except OSError as err:
            self._json_response(500, {"error": str(err)})
            return
        self._json_response(
            200,
            {
                "ok": True,
                "kind": kind,
                "path": path_rel,
                "validation": validation,
            },
        )

    def _handle_verify_media(self) -> None:
        payload = self._read_json_body()
        if payload is None:
            return
        path_rel = payload.get("path")
        if not isinstance(path_rel, str):
            self._json_response(400, {"error": "Expected path (str)"})
            return
        try:
            target = _resolve_library_song_path(path_rel)
        except ValueError as err:
            self._json_response(400, {"error": str(err)})
            return
        if not target.exists():
            self._json_response(404, {"error": "Song not found"})
            return
        media_dir = _media_dir_for_song(target)
        lyrics_path = media_dir / "lyrics.vtt"
        chords_path = media_dir / "chords.vtt"
        try:
            lyrics_text = lyrics_path.read_text(encoding="utf-8") if lyrics_path.is_file() else "WEBVTT\n"
            chords_text = chords_path.read_text(encoding="utf-8") if chords_path.is_file() else "WEBVTT\n"
        except OSError as err:
            self._json_response(500, {"error": str(err)})
            return
        validation = validate_vtt_pair_text(lyrics_text, chords_text)
        if not validation["ok"] or validation["warnings"]:
            self._json_response(
                400,
                {
                    "error": (validation["issues"] or ["VTT validation failed"])[0],
                    "validation": validation,
                },
            )
            return
        raw = target.read_text(encoding="utf-8")
        meta, body = _split_song_markdown(raw)
        meta = _normalize_meta({**meta, "media_status": "ready", "media_verified_at": _utc_now()})
        try:
            target.write_text(_to_song_markdown(meta, body), encoding="utf-8")
            rebuild_index(LIBRARY)
            media_json_path = media_dir / "media.json"
            if media_json_path.is_file():
                try:
                    data = json.loads(media_json_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    data = {}
                data["status"] = "ready"
                data["verified_at"] = meta["media_verified_at"]
                media_json_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except OSError as err:
            self._json_response(500, {"error": str(err)})
            return
        self._json_response(
            200,
            {
                "ok": True,
                "path": path_rel,
                "media_status": "ready",
                "media_verified_at": meta["media_verified_at"],
            },
        )

    def _handle_reprocess_media(self) -> None:
        payload = self._read_json_body()
        if payload is None:
            return
        path_rel = payload.get("path") or payload.get("song_path")
        if not isinstance(path_rel, str) or not path_rel.strip():
            self._json_response(400, {"error": "Expected path (str)"})
            return
        try:
            target = _resolve_library_song_path(path_rel.strip())
        except ValueError as err:
            self._json_response(400, {"error": str(err)})
            return
        if not target.exists():
            self._json_response(404, {"error": "Song not found"})
            return

        raw = target.read_text(encoding="utf-8")
        meta, body = _split_song_markdown(raw)
        meta = _normalize_meta(meta)
        if payload.get("youtube_url") and isinstance(payload.get("youtube_url"), str):
            meta["youtube_url"] = payload["youtube_url"].strip()
        if isinstance(payload.get("chart_body"), str):
            body = payload["chart_body"]
        elif isinstance(payload.get("body"), str):
            body = payload["body"]

        youtube_url = (meta.get("youtube_url") or "").strip()
        if not youtube_url:
            self._json_response(400, {"error": "YouTube URL is required to reprocess"})
            return

        enqueue_info = _maybe_enqueue_media(path_rel.strip(), meta, body, meta, force=True)
        if not enqueue_info.get("enqueued"):
            self._json_response(
                502 if enqueue_info.get("error") else 400,
                {"error": enqueue_info.get("error") or enqueue_info.get("reason") or "Enqueue failed"},
            )
            return

        meta["media_status"] = "queued"
        meta["media_verified_at"] = None
        try:
            target.write_text(_to_song_markdown(meta, body), encoding="utf-8")
            rebuild_index(LIBRARY)
        except OSError as err:
            self._json_response(500, {"error": f"Write failed: {err}"})
            return

        self._json_response(
            200,
            {
                "ok": True,
                "path": path_rel.strip(),
                "media_status": "queued",
                "media": enqueue_info,
            },
        )

    def _handle_export_media(self) -> None:
        payload = self._read_json_body()
        if payload is None:
            return
        path_rel = payload.get("song_path") or payload.get("path")
        if not isinstance(path_rel, str) or not path_rel.strip():
            self._json_response(400, {"error": "Expected song_path (str)"})
            return
        cleaned = path_rel.strip().lstrip("/")
        if cleaned.startswith("library/"):
            cleaned = cleaned[len("library/") :]
        try:
            target = _resolve_library_song_path(cleaned)
        except ValueError as err:
            self._json_response(400, {"error": str(err)})
            return
        if not target.exists():
            self._json_response(404, {"error": "Song not found"})
            return
        meta, body = _split_song_markdown(target.read_text(encoding="utf-8"))
        width = payload.get("width", 1920)
        height = payload.get("height", 1080)
        fps = payload.get("fps", None)
        try:
            width = int(width)
            height = int(height)
        except (TypeError, ValueError):
            self._json_response(400, {"error": "width/height must be integers"})
            return
        if fps is not None:
            try:
                fps = float(fps)
            except (TypeError, ValueError):
                self._json_response(400, {"error": "fps must be a number or null"})
                return
        mix = payload.get("mix") if isinstance(payload.get("mix"), str) else "original"
        mix = mix.strip() or "original"
        muted = payload.get("muted") if isinstance(payload.get("muted"), dict) else {}
        soloed = payload.get("soloed") if isinstance(payload.get("soloed"), dict) else {}
        chart_body = payload.get("chart_body") if isinstance(payload.get("chart_body"), str) else body
        show_drums = payload.get("show_drums", True)
        if not isinstance(show_drums, bool):
            show_drums = str(show_drums).strip().lower() not in ("0", "false", "no", "")
        body_payload = {
            "job_type": "export_video",
            "song_path": cleaned,
            "mix": mix,
            "muted": {str(k): bool(v) for k, v in muted.items()},
            "soloed": {str(k): bool(v) for k, v in soloed.items()},
            "width": width,
            "height": height,
            "fps": fps,
            "title": payload.get("title") or meta.get("title"),
            "artist": payload.get("artist") or meta.get("artist"),
            "chart_body": chart_body or "",
            "show_drums": show_drums,
        }
        self._proxy_media(
            "POST",
            "/v1/jobs",
            body=json.dumps(body_payload).encode("utf-8"),
            timeout=30,
        )

    def _json_response(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)


def _media_request(
    method: str,
    path: str,
    body: bytes | None = None,
    *,
    timeout: float = 30,
) -> tuple[int, bytes, str | None]:
    url = f"{MEDIA_API_URL}{path}"
    req = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), resp.headers.get("Content-Type")
    except urllib.error.HTTPError as err:
        return err.code, err.read(), err.headers.get("Content-Type")


def _media_dir_for_song(song_md: Path) -> Path:
    return song_md.with_suffix("")


def _resolve_media_file(song_md: Path, rel_file: str) -> Path:
    cleaned = unquote(rel_file).lstrip("/").replace("\\", "/")
    if ".." in cleaned.split("/"):
        raise ValueError("File path must not contain '..'")
    media_dir = _media_dir_for_song(song_md).resolve()
    target = (media_dir / cleaned).resolve()
    if not str(target).startswith(str(media_dir) + os.sep) and target != media_dir:
        raise ValueError("File path escapes media directory")
    return target


def _cleanup_empty_parents(song_path: Path) -> None:
    """Remove empty album/artist dirs after deleting a song file."""
    artists_root = (LIBRARY / "artists").resolve()
    current = song_path.parent.resolve()
    while current != artists_root and artists_root in current.parents:
        try:
            next(current.iterdir())
            break
        except StopIteration:
            parent = current.parent
            current.rmdir()
            current = parent


def _resolve_library_song_path(path_rel: str) -> Path:
    """Resolve a library-relative song path; reject escapes outside library/artists."""
    cleaned = unquote(path_rel).lstrip("/").replace("\\", "/")
    if cleaned.startswith("library/"):
        cleaned = cleaned[len("library/") :]
    if ".." in cleaned.split("/"):
        raise ValueError("Path must not contain '..'")
    if not cleaned.startswith("artists/") or not cleaned.endswith(".md"):
        raise ValueError("Path must be under artists/ and end with .md")
    target = (LIBRARY / cleaned).resolve()
    artists_root = (LIBRARY / "artists").resolve()
    if not str(target).startswith(str(artists_root) + os.sep) and target != artists_root:
        raise ValueError("Path escapes library/artists")
    return target


def _split_song_markdown(raw: str) -> tuple[dict[str, Any], str]:
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    fm_raw = text[3:end].strip("\n")
    rest = text[end + 4 :].lstrip("\n")
    meta = load_frontmatter(fm_raw) if fm_raw else {}
    body = rest
    if body.startswith("```"):
        lines = body.split("\n")
        # drop opening fence
        lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        elif len(lines) >= 2 and lines[-1].strip() == "" and lines[-2].strip() == "```":
            lines = lines[:-2]
        body = "\n".join(lines)
    return meta if isinstance(meta, dict) else {}, body


def _normalize_youtube_url(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    lowered = text.lower()
    if "youtube.com" in lowered or "youtu.be" in lowered:
        return text
    return text  # allow storing; enqueue validates


def _normalize_media_status(value: Any) -> str:
    text = str(value or "none").strip().lower() or "none"
    if text not in MEDIA_STATUSES:
        return "none"
    return text


def _normalize_meta(meta: dict[str, Any]) -> dict[str, Any]:
    chords = meta.get("chords")
    if isinstance(chords, str):
        chords = [c.strip() for c in chords.split(",") if c.strip()]
    elif not isinstance(chords, list):
        chords = []
    else:
        chords = [str(c).strip() for c in chords if str(c).strip()]

    capo = meta.get("capo", 0)
    try:
        capo = int(capo or 0)
    except (TypeError, ValueError):
        capo = 0

    scroll_speed = meta.get("scroll_speed", 1.0)
    try:
        scroll_speed = float(scroll_speed if scroll_speed is not None else 1.0)
    except (TypeError, ValueError):
        scroll_speed = 1.0
    scroll_speed = max(0.5, min(4.0, scroll_speed))

    start_delay = meta.get("start_delay", 0)
    try:
        start_delay = float(start_delay if start_delay is not None else 0)
    except (TypeError, ValueError):
        start_delay = 0.0
    start_delay = max(0.0, min(30.0, start_delay))

    key = meta.get("key")
    if key == "" or key is None:
        key = None
    else:
        key = str(key)

    youtube_url = _normalize_youtube_url(meta.get("youtube_url"))
    media_status = _normalize_media_status(meta.get("media_status"))
    if not youtube_url and media_status == "none":
        media_status = "none"

    verified = meta.get("media_verified_at")
    if verified in ("", None):
        verified = None
    else:
        verified = str(verified)

    out: dict[str, Any] = {
        "title": str(meta.get("title") or "Untitled"),
        "artist": str(meta.get("artist") or "Unknown"),
        "album": str(meta.get("album") or "singles"),
        "tuning": str(meta.get("tuning") or "E A D G B E"),
        "capo": capo,
        "key": key,
        "difficulty": meta.get("difficulty") if meta.get("difficulty") not in ("", None) else None,
        "source": str(meta.get("source") or ""),
        "source_id": str(meta.get("source_id") or ""),
        "imported_at": meta.get("imported_at") if meta.get("imported_at") not in ("", None) else None,
        "scroll_speed": scroll_speed,
        "start_delay": start_delay,
        "chords": chords,
        "youtube_url": youtube_url,
        "media_status": media_status,
        "media_verified_at": verified,
    }
    return out


def _should_enqueue(new_meta: dict[str, Any], prev_meta: dict[str, Any]) -> bool:
    youtube_url = (new_meta.get("youtube_url") or "").strip()
    if not youtube_url:
        return False
    prev_url = str(prev_meta.get("youtube_url") or "").strip()
    prev_status = _normalize_media_status(prev_meta.get("media_status"))
    url_changed = youtube_url != prev_url and bool(youtube_url)
    if url_changed:
        return True
    if prev_status not in ACTIVE_MEDIA:
        return True
    return False


def _maybe_enqueue_media(
    path_rel: str,
    meta: dict[str, Any],
    body: str,
    prev_meta: dict[str, Any],
    *,
    force: bool = False,
) -> dict[str, Any]:
    youtube_url = (meta.get("youtube_url") or "").strip()
    if not youtube_url:
        return {"enqueued": False, "reason": "missing_youtube_url"}
    if not force and not _should_enqueue(meta, prev_meta):
        return {"enqueued": False, "reason": "not_needed"}
    cleaned = path_rel.strip().lstrip("/")
    if cleaned.startswith("library/"):
        cleaned = cleaned[len("library/") :]
    payload = json.dumps(
        {
            "song_path": cleaned,
            "youtube_url": youtube_url,
            "chart_body": body,
            "title": meta.get("title"),
            "artist": meta.get("artist"),
        }
    ).encode("utf-8")
    try:
        status, data, _ = _media_request("POST", "/v1/jobs", body=payload)
    except Exception as err:
        return {"enqueued": False, "error": str(err)}
    try:
        parsed = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        parsed = {"raw": data.decode("utf-8", errors="replace")}
    if status >= 400:
        err = parsed.get("error") if isinstance(parsed, dict) else None
        message = err.get("message") if isinstance(err, dict) else str(parsed)
        return {"enqueued": False, "error": message, "status": status}
    return {"enqueued": True, "job": parsed, "status": status}


def _to_song_markdown(meta: dict[str, Any], body: str) -> str:
    body = body.replace("\r\n", "\n").replace("\r", "\n").rstrip() + "\n"
    dumped = dump_frontmatter(meta)
    return f"---\n{dumped}---\n\n```\n{body.rstrip()}\n```\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve instrument-karaoke site (admin mode)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    os.chdir(ROOT)
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving {ROOT} at http://{args.host}:{args.port}/ (admin)")
    print(f"Media API: {MEDIA_API_URL}")
    print("API: GET /api/status  PUT|DELETE /api/song  /api/queue  /api/media")
    print("Press Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
