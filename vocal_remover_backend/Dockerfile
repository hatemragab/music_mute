# syntax=docker/dockerfile:1

# ── Stage: base ──────────────────────────────────────────────────────────────
# System deps + Python deps. Reused by both api and worker (single image).
FROM python:3.11-slim AS base

# ffmpeg + build tools + runtime libs required by diffq / python-magic / libsndfile / curl
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
        g++ \
        ffmpeg \
        libsndfile1 \
        libmagic1 \
        libgomp1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# ── Stage: models ────────────────────────────────────────────────────────────
# Placeholder layer so MODEL_DIR exists and documents which ONNX files belong
# here. Real ~300 MB downloads are intentionally NOT performed in CI builds;
# they are baked by CI cache or a separate model-fetch step.
FROM base AS models

RUN mkdir -p /app/models && \
    echo "# models baked at build time: UVR-MDX-NET-Inst_HQ_3.onnx Kim_Vocal_2.onnx (~300MB)." > /app/models/README.txt && \
    echo "# Download via: audio-separator --model_filename UVR-MDX-NET-Inst_HQ_3 --output_dir /app/models" >> /app/models/README.txt && \
    echo "# Or: python -m audio_separator --model_filename Kim_Vocal_2 --output_dir /app/models" >> /app/models/README.txt

# ── Stage: final ─────────────────────────────────────────────────────────────
FROM models AS final

# Copy application code (keep last for best layer caching)
COPY app ./app

ENV MODEL_DIR=/app/models \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8000}/api/v1/health || exit 1

# Default entrypoint is the API. Cloud Run injects $PORT (default 8080).
# Workers override the command via Cloud Run Jobs: --command "python,-m,app.workers.separation"
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
