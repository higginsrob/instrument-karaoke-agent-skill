from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

from server.config import settings

logger = logging.getLogger(__name__)

# Writable copy — compose mounts ./secrets as :ro, but yt-dlp always rewrites --cookies on exit.
_COOKIES_RUNTIME = Path("/tmp/youtube.cookies.txt")


@dataclass
class YouTubeMetadata:
    id: str
    title: str
    uploader: str
    duration: int
    url: str
    thumbnail: Optional[str] = None
    artist: Optional[str] = None
    files: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "url": self.url,
            "duration": self.duration,
            "uploader": self.uploader,
            "artist": self.artist,
            "thumbnail_url": self.thumbnail,
            "files": self.files,
        }


class YouTubeService:
    def __init__(self) -> None:
        self.base_args = [
            "yt-dlp",
            "--no-warnings",
            "--no-playlist",
            "--force-ipv4",
            # Fallback if yt-dlp-ejs wheel is missing; Deno can pull solvers from GitHub.
            "--remote-components",
            "ejs:github",
        ]
        cookies_path = self._prepare_cookies()
        if cookies_path:
            self.base_args.extend(["--cookies", str(cookies_path)])
            logger.info("Using YouTube cookies file: %s", cookies_path)
        elif settings.youtube_cookies_file:
            logger.warning(
                "YOUTUBE_COOKIES_FILE set to %s but file is missing — downloads may fail bot checks",
                settings.youtube_cookies_file,
            )

    @staticmethod
    def _prepare_cookies() -> Optional[Path]:
        source = settings.youtube_cookies_file
        if not source or not source.is_file():
            return None
        try:
            shutil.copy2(source, _COOKIES_RUNTIME)
        except OSError as exc:
            logger.warning("Could not copy cookies to %s: %s", _COOKIES_RUNTIME, exc)
            # Fall back to source only if it is writable; otherwise yt-dlp crashes on exit.
            if source.exists() and os.access(source, os.W_OK):
                return source
            return None
        return _COOKIES_RUNTIME

    @staticmethod
    def is_youtube_url(url: str) -> bool:
        lowered = url.lower()
        return any(token in lowered for token in ("youtube.com", "youtu.be"))

    @staticmethod
    def extract_video_id(url: str) -> Optional[str]:
        import re

        patterns = [
            r"(?:v=|/)([0-9A-Za-z_-]{11}).*",
            r"youtu\.be/([0-9A-Za-z_-]{11})",
        ]
        for pattern in patterns:
            match = re.search(pattern, url)
            if match:
                return match.group(1)
        return None

    @staticmethod
    def _format_ytdlp_error(stderr: str, fallback: str) -> str:
        text = (stderr or "").strip() or fallback
        lowered = text.lower()
        if "sign in to confirm" in lowered or "not a bot" in lowered:
            return (
                f"{text}\n\n"
                "YouTube is blocking this container. Export browser cookies to "
                "services/media-pipeline/secrets/youtube.cookies.txt and restart "
                "with YOUTUBE_COOKIES_FILE=/secrets/youtube.cookies.txt "
                "(see services/media-pipeline/README.md)."
            )
        if "format is not available" in lowered or "only images are available" in lowered:
            return (
                f"{text}\n\n"
                "YouTube returned no playable formats (often missing JS challenge solving). "
                "Rebuild the media-pipeline image so Deno + yt-dlp[default] are installed, "
                "then re-export cookies with `make youtube-cookies`."
            )
        return text

    def _run_ytdlp(self, args: list[str], *, timeout: int = 600) -> subprocess.CompletedProcess[str]:
        cmd = self.base_args + args
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("YouTube operation timed out") from exc

    def fetch_info(self, url: str) -> dict[str, Any]:
        result = self._run_ytdlp(
            [
                "--dump-single-json",
                "--no-download",
                "--ignore-no-formats-error",
                url,
            ],
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(
                self._format_ytdlp_error(result.stderr, "Failed to fetch YouTube metadata")
            )
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                self._format_ytdlp_error(result.stderr, "Failed to parse YouTube metadata")
            ) from exc

    def parse_metadata(self, info: dict[str, Any]) -> YouTubeMetadata:
        artist = None
        for key in ("artist", "track_artist", "creator", "uploader", "channel"):
            value = info.get(key)
            if value:
                artist = str(value)
                break
        return YouTubeMetadata(
            id=str(info.get("id") or ""),
            title=str(info.get("title") or "Unknown"),
            uploader=str(info.get("uploader") or ""),
            duration=int(info.get("duration") or 0),
            url=str(info.get("webpage_url") or info.get("original_url") or ""),
            thumbnail=info.get("thumbnail"),
            artist=artist,
        )

    @staticmethod
    def _thumbnail_by_width(thumbnails: list[dict[str, Any]], *, prefer: str) -> Optional[str]:
        if not thumbnails:
            return None
        sorted_thumbs = sorted(thumbnails, key=lambda item: int(item.get("width") or 0))
        if prefer == "poster":
            return str(sorted_thumbs[-1].get("url") or "")
        if len(sorted_thumbs) >= 2:
            return str(sorted_thumbs[-2].get("url") or sorted_thumbs[-1].get("url") or "")
        return str(sorted_thumbs[-1].get("url") or "")

    @staticmethod
    def _extension_from_url(url: str, default: str = ".jpg") -> str:
        path = urlparse(url).path
        suffix = Path(path).suffix.lower()
        if suffix in {".jpg", ".jpeg", ".png", ".webp"}:
            return suffix
        return default

    def _download_url_to_file(self, url: str, destination: Path) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with httpx.Client(timeout=60.0, follow_redirects=True) as client:
            response = client.get(url)
            response.raise_for_status()
            destination.write_bytes(response.content)
        return destination

    @staticmethod
    def _convert_image_to_jpeg(source: Path, destination: Path) -> Path:
        if source.suffix.lower() in {".jpg", ".jpeg"} and source != destination:
            source.replace(destination)
            return destination
        cmd = ["ffmpeg", "-y", "-i", str(source), str(destination)]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or f"Failed to convert image {source}")
        if source != destination and source.exists():
            source.unlink(missing_ok=True)
        return destination

    def _download_images(self, info: dict[str, Any], assets_dir: Path) -> dict[str, str]:
        thumbnails = info.get("thumbnails") or []
        files: dict[str, str] = {}
        poster_url = self._thumbnail_by_width(thumbnails, prefer="poster") or info.get("thumbnail")
        if poster_url:
            poster_src = assets_dir / f"poster{self._extension_from_url(poster_url)}"
            self._download_url_to_file(str(poster_url), poster_src)
            poster_path = self._convert_image_to_jpeg(poster_src, assets_dir / "poster.jpg")
            files["poster"] = poster_path.name
        return files

    def _download_video(self, url: str, assets_dir: Path, max_height: int) -> Optional[Path]:
        output_template = str(assets_dir / "video.%(ext)s")
        format_selector = (
            f"bestvideo[height<={max_height}][vcodec!=none]+bestaudio[acodec!=none]/"
            f"best[height<={max_height}]/"
            f"bv*+ba/b"
        )
        result = self._run_ytdlp(
            [
                "-f",
                format_selector,
                "--merge-output-format",
                "mp4",
                "-o",
                output_template,
                url,
            ]
        )
        if result.returncode != 0:
            err = self._format_ytdlp_error(result.stderr, "YouTube video download failed")
            lowered = err.lower()
            if "format is not available" in lowered or "drm" in lowered:
                logger.warning("Video formats unavailable; falling back to audio-only: %s", err)
                return None
            raise RuntimeError(err)
        for candidate in sorted(assets_dir.glob("video.*")):
            if candidate.is_file():
                return candidate
        return None

    @staticmethod
    def _extract_audio(video_path: Path, audio_path: Path) -> Path:
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(video_path),
            "-vn",
            "-codec:a",
            "libmp3lame",
            "-q:a",
            "0",
            str(audio_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "Failed to extract audio from YouTube video")
        return audio_path

    def _download_audio_only(self, url: str, output_dir: Path, stem: str) -> Path:
        output_template = str(output_dir / f"{stem}.%(ext)s")
        result = self._run_ytdlp(
            [
                "-x",
                "--audio-format",
                "mp3",
                "--audio-quality",
                "0",
                "-o",
                output_template,
                url,
            ]
        )
        if result.returncode != 0:
            raise RuntimeError(
                self._format_ytdlp_error(result.stderr, "YouTube audio download failed")
            )
        candidates = sorted(output_dir.glob(f"{stem}.*"))
        if not candidates:
            candidates = sorted(output_dir.glob("*.mp3"))
        if not candidates:
            raise RuntimeError("Download completed but no audio file was found")
        return candidates[0]

    def download_for_song(self, url: str, media_dir: Path) -> tuple[Path, YouTubeMetadata]:
        info = self.fetch_info(url)
        metadata = self.parse_metadata(info)
        if metadata.duration > settings.max_duration_seconds:
            minutes, seconds = divmod(metadata.duration, 60)
            raise ValueError(
                f"Audio is limited to {settings.max_duration_seconds // 60} minutes. "
                f"This video is {minutes} minutes {seconds} seconds."
            )

        media_dir.mkdir(parents=True, exist_ok=True)
        assets_dir = media_dir / "youtube"
        assets_dir.mkdir(parents=True, exist_ok=True)

        metadata.files.update(self._download_images(info, assets_dir))

        audio_path = media_dir / "source.mp3"
        if settings.youtube_save_video:
            video_path = self._download_video(url, assets_dir, settings.youtube_max_video_height)
            if video_path:
                metadata.files["video"] = video_path.name
                self._extract_audio(video_path, audio_path)
            else:
                audio_path = self._download_audio_only(url, media_dir, "source")
        else:
            audio_path = self._download_audio_only(url, media_dir, "source")

        metadata.files["source_audio"] = audio_path.name
        metadata_path = assets_dir / "metadata.json"
        metadata_path.write_text(json.dumps(metadata.to_dict(), indent=2), encoding="utf-8")
        metadata.files["metadata"] = metadata_path.name
        return audio_path, metadata
