# CPU media-pipeline image (no NVIDIA GPU required)
FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1 \
    TORCH_HOME=/data/models \
    JOBS_DIR=/data/jobs \
    LIBRARY_DIR=/library \
    PORT=8093 \
    DEMUCS_DEVICE=cpu \
    ADTOF_DEVICE=cpu \
    ALIGN_DEVICE=cpu

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    git \
    curl \
    ca-certificates \
    unzip \
    build-essential \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Deno solves YouTube JS challenges for yt-dlp (EJS). Without it only storyboards are available.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && deno --version

COPY requirements.txt /app/requirements.txt
RUN python3 -m pip install --no-cache-dir -r /app/requirements.txt \
    && python3 -m pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        torch torchaudio \
    # demucs 4.1+ pulls sphn (Rust/Opus) which fails to build on aarch64 slim.
    # Pin 4.0.1 and install its classic deps without pulling a newer demucs.
    && python3 -m pip install --no-cache-dir --no-deps "demucs==4.0.1" \
    && python3 -m pip install --no-cache-dir \
        dora-search einops julius lameenc openunmix tqdm \
    && python3 -m pip install --no-cache-dir --no-deps \
        git+https://github.com/xavriley/ADTOF-pytorch.git \
    && python3 -m pip install --no-cache-dir pretty_midi

COPY server /app/server

# Smoke-import demucs without downloading models (models land in TORCH_HOME at runtime).
RUN python3 -c "import torch; import demucs.separate; print('torch', torch.__version__, 'demucs ok')"

RUN mkdir -p /data/jobs /data/models /library

EXPOSE 8093
VOLUME ["/data/jobs", "/data/models", "/library"]

CMD ["python3", "-m", "uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8093", "--workers", "1"]
