# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project — Vocal Remover Service

CPU-only audio separation on **Cloud Run only (no VPS)**. Flutter Android app → Cloud Run Service (FastAPI) → Cloud Tasks + Cloud Run Jobs (python-audio-separator ONNX, yt-dlp/ffmpeg) → **AWS S3** + **MongoDB Atlas** (both outside GCP). $300 GCP credit, 90-day expiry. No GCS, no Firestore. PLAN.md is source of truth — read it first.

## Repo State — Pre-Scaffold (Plan-Only)

This repo currently contains **only** `PLAN.md` (+ this file). Both `vocal_remover_backend/` and `vocal_remover_mobile/` are empty placeholders, no `pubspec.yaml`/`requirements.txt`/`Dockerfile`/`cloudbuild.yaml` yet, no `README.md`, not a git repo. Do not assume backend/mobile files exist — verify with `ls` before editing. Expected layout when scaffolded is `PLAN.md` section 5. No `docker-compose.yml`, no `nginx/`, no `deploy/setup_vps.sh` or `init_letsencrypt.sh` — those were removed for Cloud Run (see PLAN 7.4).

## Commands

Scaffolding not done — no build/lint/test commands exist yet. When they land, expected commands per PLAN.md are:

```bash
# Backend (Python 3.11, FastAPI — Cloud Run, no Redis/RQ, no Compose)
# from vocal_remover_backend/
pip install -r requirements.txt          # or uv sync if migrated
uvicorn app.main:app --reload --port 8000
python -m app.workers.separation --job-id xxx   # single job run (inside Cloud Run Job)
pytest                                   # tests/test_api.py, tests/test_separator.py
pytest tests/test_api.py::test_name -v   # single test
ruff check . && ruff format .             # lint/format if added
# Cloud Run deploy (replaces docker compose up --build)
gcloud builds submit --config cloudbuild.yaml                          # build → Artifact Registry
gcloud run deploy vocal-remover-api --image $IMAGE --region us-central1 --allow-unauthenticated --memory 2Gi --cpu 2
gcloud run jobs create vocal-remover-worker --image $IMAGE --region us-central1 --memory 8Gi --cpu 4 --task-timeout 900 --command "python,-m,app.workers.separation"
# Console alternatives: Cloud Run → Deploy a web service (Deploy container / Connect repository) for api;
#                       Cloud Run → Create a batch job or background worker pool → Create job for workers

# Mobile (Flutter 3.x / Dart 3, from vocal_remover_mobile/)
flutter pub get
flutter analyze
flutter test
flutter test test/widget_test.dart -v    # single test
flutter run                               # device/emulator
flutter build apk --release              # APK for sideload
dart format .

# Knowledge graph (preferred before Grep/Glob/Read — see global CLAUDE.md graph tools)
# embed_graph -> semantic_search_nodes / query_graph -> get_impact_radius / get_affected_flows / detect_changes
```

## Architecture — Read PLAN.md Sections 2-6 Before Changing Code

```
Flutter APK ──HTTPS (Cloud Run auto TLS)──> Cloud Run Service: api (FastAPI /api/v1)
                                              ├─enqueue─> Cloud Tasks (vocal-jobs, on GCP) ──> Cloud Run Jobs (workers, 2-4 vCPU 4-8 GB, CPU always allocated, ONNX baked)
                                              │                                                    separation.py -> services/separator.py (ONNX) + youtube.py (yt-dlp via Secret Manager) + ffmpeg.py
                                              ├─state───> MongoDB Atlas (outside GCP, jobs collection, TTL index 7d)
                                              └─storage─> AWS S3 (outside GCP, uploads/{job_id}/ 1d lifecycle, results/{job_id}/ 7d; presigned URLs 15 min)
```

- **Separation:** default `UVR-MDX-NET-Inst_HQ_3` 2-stem (vocals+instrumental); `Kim_Vocal_2` vocals-only second option; optional `htdemucs` 4-stem — models baked in image (~300 MB ONNX), env `DEFAULT_MODEL` switches. No BS-RoFormer/Spleeter (PLAN 3.1/3.5).
- **YouTube:** `yt-dlp --dump-json` preflight (reject >20 min / >50 MB), then `bestaudio` -> ffmpeg 44.1 kHz stereo wav; cookies via Secret Manager (`YT_COOKIES_SECRET`), `YT_COOKIES_FILE` fallback for local dev only.
- **API (under /api/v1):** `POST /separate` multipart (`file` OR `youtube_url`, fields `model` default `UVR-MDX-NET-Inst_HQ_3`, `stems` `vocals|2stems|4stems`) -> 202 `{job_id, status: queued}`; `GET /jobs/{job_id}` polls **MongoDB Atlas** `{status, progress, stage, results[]}`; `GET /models` / `GET /results/{job_id}/{filename}` 302 to **S3 presigned URL** (15 min) / `GET /health`. Limits: 50 MB, 20 min, 2 concurrent/IP, S3 lifecycle 1d uploads / 7d results + MongoDB TTL (no cron, no GCS, no Firestore).
- **Pipeline per job:** upload to **S3** or yt-dlp (inside Job, /tmp) -> ffmpeg probe/convert -> separate (progress 0-100 via **MongoDB**) -> ffmpeg mp3 192k -> delete S3 uploads, keep results 7d (PLAN 6).
- **Flutter:** `riverpod` + `dio` (progress) + `sqflite` (job history) + `file_picker` + `just_audio` per-stem playback; first-launch settings for backend URL; poll `/jobs/{id}` every 3s; features `home/jobs/player/settings`, core `api_client/settings/theme/result`, data `job/job_dao/models_catalog`.

## Key Files (When Scaffolded)

- `vocal_remover_backend/app/main.py` — FastAPI app + routes (Cloud Run Service)
- `vocal_remover_backend/app/config.py` — env (`APP_ENV`, `GCP_PROJECT_ID`, `GCP_REGION`, `S3_BUCKET`, `AWS_REGION`, `MONGODB_URI`/`MONGODB_DB`, `TASK_QUEUE`, `DEFAULT_MODEL=UVR-MDX-NET-Inst_HQ_3`, `MODEL_DIR=/app/models`, `YT_COOKIES_SECRET`, `BASE_URL`, `JOB_TIMEOUT_S`, `.env.example`)
- `vocal_remover_backend/app/jobs.py` — Cloud Tasks enqueue + **MongoDB Atlas** helpers (replaces RQ/Firestore)
- `vocal_remover_backend/app/db.py` — Motor/Beanie MongoDB client
- `vocal_remover_backend/app/workers/separation.py`, `app/services/separator.py` — separation task (runs inside Cloud Run Job, CPU always allocated)
- `vocal_remover_backend/app/services/youtube.py`, `app/services/ffmpeg.py`, `app/storage.py` (**S3** + presigned URLs + lifecycle), `app/models.py` — yt-dlp / ffmpeg / S3 / Pydantic schemas
- `vocal_remover_backend/Dockerfile` (single image, baked ONNX models), `cloudbuild.yaml` (build→push→deploy), `deploy/deploy.sh` (gcloud run deploy + jobs + tasks + S3 + Atlas)
- `vocal_remover_mobile/lib/core/api_client.dart`, `lib/data/job.dart`, `lib/features/{home,jobs,player,settings}/`

## Env & Deploy — Cloud Run Only (no VPS, no Nginx)

`vocal_remover_backend/.env.example` governs runtime. **No Docker Compose, no Nginx, no certbot, no UFW, no GCS, no Firestore.** Cloud Run handles TLS + HTTP→HTTPS + concurrency. Rate limit via `slowapi` + optional Cloud Armor. Deploy: `gcloud builds submit --config cloudbuild.yaml` → Artifact Registry → `gcloud run deploy` (api) + `gcloud run jobs create` (workers). One-time: **Atlas** cluster + `jobs` collection + TTL index + **S3** bucket + lifecycle (`uploads/` 1d, `results/` 7d) + `gcloud tasks queues create vocal-jobs` (no `gsutil mb`, no `gcloud firestore`). Budget: ~$25-55/mo → ~$75-165/90 days inside $300. See PLAN 7/10.

## Constraints (PLAN 3.5)

No GPU/CUDA, no auth in v1, no iOS. No VPS / Compose / Nginx / certbot / GCS / Firestore — Cloud Run only, TLS automatic. No local `/data` (ephemeral) — **AWS S3** + **MongoDB Atlas** outside GCP. File-type sniffing via `python-magic`. Rate limit via `slowapi`/Cloud Armor. S3 lifecycle + MongoDB TTL replace cron (uploads 1d, results 7d).

## Importable External Config

User-level configs detected on this machine: `~/.codex/config.toml`, `~/.gemini/settings.json`. To import MCP servers / slash commands / subagents / skills / instructions from them, reply `/import` to scan what's importable, then `/import --yes=<digest>` (digest shown in scan) to apply. If `/import` isn't available here, run `claude import` in a terminal instead. No Cursor (`.cursor/`, `.cursorrules`) or Copilot (`.github/copilot-instructions.md`) rules detected.
