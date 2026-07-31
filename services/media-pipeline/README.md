# Instrument Karaoke Media Pipeline

API-only Docker service: YouTube download → `htdemucs` (4 stems) → pre-render karaoke mixes → force-align chart lyrics → ADTOF drums→MIDI.

Writes artifacts beside each song under `library/artists/.../<slug>/` including `stems/` (pipeline-only WAVs) and `mixes/*.mp3` (Original, karaoke, and solo stem files — the player streams exactly one at a time).

## Quick start (CPU)

```bash
cd services/media-pipeline
docker compose up          # start (reuse existing image)
# docker compose build     # only when Dockerfile / server code changed
```

Health: `http://127.0.0.1:8093/healthz`

## GPU (NVIDIA / DGX Spark)

```bash
docker compose --profile gpu up media-pipeline-gpu
```

Base image: `nvcr.io/nvidia/pytorch:26.06-py3`.

## From repo root

```bash
make media-up          # CPU — starts container, does not rebuild
make media-up-gpu      # GPU
make media-build-cpu   # rebuild CPU image when needed
make media-build-gpu   # rebuild GPU image when needed
make media-build       # rebuild both images
```

Set `MEDIA_API_URL=http://127.0.0.1:8093` when running `make server`.

## YouTube cookies (required when bot-checked)

YouTube often returns `Sign in to confirm you're not a bot` for Docker IPs.

```bash
# from repo root (default browser: chrome)
make youtube-cookies

# or: make youtube-cookies BROWSER=safari
# or: make youtube-cookies BROWSER=firefox
```

That writes `services/media-pipeline/secrets/youtube.cookies.txt` (gitignored). Compose mounts `./secrets` → `/secrets` (read-only); the API copies cookies to `/tmp` at runtime. Restart the container after exporting (`make media-up`).

Requires local `yt-dlp` (`brew install yt-dlp`) and a browser session signed into YouTube.

The Docker image also needs **Deno** plus `yt-dlp[default]` (EJS solvers). Without them yt-dlp only sees storyboard images and fails with `Requested format is not available`.
