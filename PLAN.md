# Vocal Remover Service — Architecture & Deployment Plan

A self-hosted, CPU-only vocal / music separation service with a Flutter Android client.

---

## 1. Goals

- Accept an **audio file** OR a **YouTube URL** (audio-only download).
- Separate it into stems (vocals, instrumental, and optionally drums / bass / other).
- Return the stems to the user (download links in the app).
- Run entirely on **CPU-only Cloud Run** (no GPU, no VPS).
- Ship as an **Android APK** for testing.
- Fit inside **$300 GCP credit expiring in 90 days**.

---

## 2. High-Level Architecture — Cloud Run Only (no VPS)

```
┌────────────────────┐        HTTPS (auto TLS)       ┌─────────────────────────────────┐
│  Flutter Android   │ ─────────────────────────────► │  Cloud Run Service: api         │
│  App (APK)         │                                │  FastAPI (uvicorn)              │
└────────────────────┘                                │  /separate  /jobs  /models       │
                                                      │  /results  /health              │
                                                      └──────────┬──────────┬───────────┘
                                                                 │          │
                                                       enqueue   │          │ signed URLs
                                                                 ▼          ▼
                                                      ┌──────────────┐  ┌──────────────────┐
                                                      │ Cloud Tasks  │  │  AWS S3 bucket   │
                                                      │ queue:       │  │  uploads/{job}/  │
                                                      │ vocal-jobs   │  │  results/{job}/  │
                                                      └──────┬───────┘  └──────────────────┘
                                                             │
                                                             ▼
                                                      ┌──────────────────────────┐  ┌──────────────┐
                                                      │  Cloud Run Jobs          │  │ MongoDB      │
                                                      │  workers (CPU always     │◄─┤ Atlas        │
                                                      │  allocated, 2-4 vCPU,    │  │ jobs coll.   │
                                                      │  4-8 GB, ONNX models     │  └──────────────┘
                                                      │  baked in image)         │
                                                      │  audio-separator +       │
                                                      │  yt-dlp + ffmpeg         │
                                                      └──────────────────────────┘
```

**Mapping to Cloud Run console options (Overview page):**
- **API** → *Deploy a web service* → **Deploy container** (or **Connect repository**) — the FastAPI service. Auto TLS, auto scale-to-zero, no Nginx/certbot.
- **Workers** → *Create a batch job or background worker pool* → **Create job** (one-shot per separation, triggered by Cloud Tasks) or **Create worker pool** (long-lived consumers). Prefer **Jobs** for this workload — each job handles one separation then exits; no idle cost.
- **Alternative not used:** *Write a function* (Python tiles) — Cloud Functions 2nd gen is Cloud Run under the hood but adds cold-start + timeout limits worse for 2-3 min audio work; skip.
- **Storage** → **AWS S3** bucket (outside GCP) replaces local `/data` + GCS. S3 lifecycle rules replace cron cleanup. Presigned URLs (15 min) replace GCS signed URLs.
- **DB** → **MongoDB Atlas** (outside GCP) replaces Firestore. Collection `jobs` holds job docs. No Firestore.
- **Queue** → Cloud Tasks queue `vocal-jobs` still on GCP (triggers Cloud Run Jobs) — cheap, no extra infra; SQS alternative noted in appendix if you want fully off-GCP queue.

Components:
- **Cloud Run Service (api)** — FastAPI + uvicorn, validates `file` OR `youtube_url`, enforces 50 MB / 20 min, enqueues to Cloud Tasks, returns 202, serves job polls from **MongoDB Atlas** and **S3 presigned-URL** redirects for results. `slowapi` or Cloud Armor for rate limit.
- **Cloud Tasks** — durable queue `vocal-jobs` on GCP, HTTP target = Cloud Run Jobs execution (or dispatcher endpoint on api). Retries with backoff, dedup. Stays on GCP even though DB/storage are external — cheapest queue for Cloud Run triggers.
- **Cloud Run Jobs (workers)** — container image bakes ONNX models (`UVR-MDX-NET-Inst_HQ_3` + `Kim_Vocal_2`, ~300 MB ONNX) so no download on cold start. CPU always allocated, 2-4 vCPU / 4-8 GB, timeout 900s. Holds model module-level. Writes stems to `s3://bucket/results/{job_id}/`, updates **MongoDB Atlas** progress/stage.
- **AWS S3** — `uploads/{job_id}/input.*`, `results/{job_id}/*.mp3|wav`. Presigned URLs (15 min expiry) replace streaming `GET /results/...`. Lifecycle rules handle TTL.
- **MongoDB Atlas** — `jobs` collection: `{_id, status, progress, stage, results[], error, createdAt, finishedAt, ip, model, stems}` with TTL index on `finishedAt` if needed (complements S3 lifecycle). No Firestore.
- **yt-dlp + ffmpeg** — same as before, but `YT_COOKIES_FILE` comes from Secret Manager / env, not local file; yt-dlp runs inside the Job container.

---

## 3. Tech Choices & Justification

### 3.1 Separation model (CPU-friendly)

| Model | Quality | CPU Speed | RAM | Recommendation |
|-------|---------|-----------|-----|----------------|
| **MDX-Net (Kim Vocal 2 / UVR-MDX-Net-Inst_HQ_3)** | ★★★★☆ | ★★★★☆ | ~2 GB | **Default for vocals-only & 2-stem** |
| **htdemucs** (Demucs v4) | ★★★★★ | ★★☆☆☆ | ~3 GB | Optional, 4-stem, slower on CPU |
| **BS-RoFormer** | ★★★★★ | ★☆☆☆☆ | ~4 GB | Skip (too slow on CPU, blows budget) |
| Spleeter | ★★★☆☆ | ★★★★★ | ~1 GB | Only if extreme throughput needed |

**Decision:** Ship with **MDX-Net** as default. Allow 4-stem `htdemucs` as opt-in (with a "this will be slow" warning in the app).

**Backend library:** [`python-audio-separator`](https://github.com/karaokenerds/python-audio-separator) — clean API, ONNX runtime support, pre-bundles UVR models.

**Why ONNX over PyTorch:** ~30–50% faster inference on CPU, ~40% less RAM.

### 3.2 YouTube support

- Use **`yt-dlp`** (actively maintained fork of youtube-dl).
- Extract audio only: `yt-dlp -x --audio-format wav --audio-quality 0 -o out.wav <url>`.
- Use format selector `bestaudio/best` then convert to wav via ffmpeg (more reliable than `-x` alone).
- Pre-flight check: probe with `yt-dlp --dump-json` to get title, duration, thumbnail; reject > 20 min or > 50 MB.
- Cache the downloaded audio temporarily under `s3://bucket/uploads/{job_id}/` (or `/tmp` inside Job, then upload) then delete after processing.
- Cookie support: optional `YT_COOKIES_FILE` env var to bypass bot detection on age-restricted / private-with-cookie videos.

### 3.3 Backend stack — Cloud Run + external DB/storage

- **Python 3.11** — best balance of library support and performance.
- **FastAPI** + **uvicorn** — async, auto OpenAPI docs, easy validation with Pydantic. Runs on Cloud Run Service (api).
- **Cloud Tasks** — durable queue `vocal-jobs` on GCP (triggers Cloud Run Jobs). Cheap, no extra infra.
- **MongoDB Atlas** — job state (`jobs` collection). Hosted outside GCP, replaces Firestore. TTL index optional.
- **AWS S3** — durable storage for uploads/results (replaces local `/data` and GCS). Presigned URLs for downloads, lifecycle rules for TTL.
- **Cloud Run Jobs** — separation workers (one execution per job, CPU always allocated, 2-4 vCPU / 4-8 GB, 900s timeout).
- **python-audio-separator (ONNX)** — separation engine, models baked into worker image.
- **yt-dlp** + **ffmpeg** — YouTube + audio I/O (inside Job container), cookies via Secret Manager.
- **Docker** (single Dockerfile, Artifact Registry) — no Compose; Cloud Build builds + pushes image, Cloud Run pulls it.
- **No Nginx** — Cloud Run front-load-balancer handles TLS, HTTP→HTTPS, and concurrency; rate limit via `slowapi` in app + optional Cloud Armor policy.

### 3.4 Flutter app stack

- **Flutter 3.x** (stable), Dart 3.
- **State management:** `flutter_riverpod` (lightweight, testable).
- **HTTP:** `dio` (uploads with progress).
- **Local DB:** `sqflite` for job history.
- **File picker:** `file_picker`.
- **Audio playback:** `just_audio` (per-stem playback, streaming from URL).
- **YouTube URL paste:** plain `TextField` + URL validation.
- **Background-friendly UI:** progress dialog while upload + processing, with cancel.
- **APK:** release build, debug-signed for sideload testing.

### 3.5 What we explicitly do NOT use

- ❌ **GPU** (no CUDA, no onnxruntime-gpu).
- ❌ **Spleeter** as primary (quality too low to charge for).
- ❌ **BS-RoFormer** on CPU (too slow — would blow 90-day budget on long CPU time).
- ❌ **Phase-inversion** (Audacity trick — poor quality).
- ❌ **Auth / accounts** (v1, per agreed scope).
- ❌ **iOS build** (Android APK only for v1).
- ❌ **VPS / Docker Compose / Nginx / certbot** (Cloud Run only — no VMs to manage, TLS automatic, no Let's Encrypt, no UFW).
- ❌ **Local `/data` / GCS / Firestore** (ephemeral on Cloud Run — **AWS S3** + **MongoDB Atlas** outside GCP; no GCS bucket, no Firestore).

---

## 4. API Design

All endpoints under `/api/v1`.

### `POST /api/v1/separate`
- **Body:** `multipart/form-data` with one of:
  - `file` — audio file (mp3, wav, flac, m4a, ogg, opus; max 50 MB)
  - `youtube_url` — string, must be a valid YouTube watch / shorts / youtu.be URL
- **Form fields:** `model` (`UVR-MDX-NET-Inst_HQ_3` default 2-stem | `Kim_Vocal_2` vocals-only | `htdemucs` 4-stem opt-in), `stems` (`vocals` | `2stems` | `4stems`, default `2stems`). Env `DEFAULT_MODEL` controls default.
- **Response 202:**
  ```json
  { "job_id": "abc123", "status": "queued", "source": "upload" | "youtube", "title": "..." }
  ```

### `GET /api/v1/jobs/{job_id}`
- **Response 200:**
  ```json
  {
    "job_id": "abc123",
    "status": "queued|processing|done|failed",
    "progress": 0-100,
    "stage": "downloading|converting|separating|encoding|done|failed",
    "model": "mdx_net",
    "stems": ["vocals", "instrumental"],
    "results": [
      { "stem": "vocals",        "url": "/api/v1/results/abc123/vocals.wav",        "size_bytes": 1234567, "duration_s": 215 },
      { "stem": "instrumental",  "url": "/api/v1/results/abc123/instrumental.wav",  "size_bytes": 1230000, "duration_s": 215 }
    ],
    "error": null,
    "created_at": "...", "finished_at": "..."
  }
  ```

### `GET /api/v1/models`
- List available models with metadata (name, stems supported, est. speed on CPU, est. RAM).

### `GET /api/v1/results/{job_id}/{filename}`
- Returns **302 redirect to an S3 presigned URL** (15 min expiry, `Content-Disposition: attachment`). No streaming through the api service.
- Fallback `?download=1` forces `response-content-disposition=attachment` on the presigned URL.
- Rate-limited via `slowapi` + optional Cloud Armor.

### `GET /api/v1/health`
- Returns `{ "status": "ok", "mongo": "ok", "s3": "ok", "queue": "ok", "models_baked": [...] }`.

### Limits (enforced at API — no Nginx)
- Max file: 50 MB (FastAPI + S3 upload cap).
- Max duration: 20 min (YouTube pre-check + ffprobe).
- Max concurrent jobs per IP: 2 (in-memory or MongoDB counter, `slowapi` limiter).
- Result TTL: **S3 lifecycle** — `uploads/` 1 day, `results/` 7 days (configurable, default 7d) + optional MongoDB TTL index on `finishedAt`. No cron.

---

## 5. Project Layout

```
work_spaces/
├── PLAN.md                          ← this file
├── vocal_remover_backend/           ← FastAPI (Cloud Run Service) + Cloud Run Jobs workers
│   ├── app/
│   │   ├── main.py                  ← FastAPI app, routes (service)
│   │   ├── config.py                ← env loading, defaults (GCP-aware)
│   │   ├── jobs.py                  ← Cloud Tasks enqueue + MongoDB Atlas helpers (replaces RQ/Firestore)
│   │   ├── workers/
│   │   │   ├── __init__.py
│   │   │   ├── separation.py        ← separation task (runs inside Cloud Run Job)
│   │   │   └── youtube.py           ← yt-dlp download (called from separation)
│   │   ├── services/
│   │   │   ├── separator.py         ← python-audio-separator wrapper (ONNX, baked models)
│   │   │   ├── youtube.py           ← yt-dlp wrapper (Secret Manager cookies)
│   │   │   └── ffmpeg.py            ← audio probe / convert helpers
│   │   ├── db.py                    ← MongoDB Atlas client (motor/beanie)
│   │   ├── models.py                ← Pydantic schemas
│   │   ├── storage.py               ← S3 paths + presigned URLs + lifecycle (replaces GCS)
│   │   └── logging.py
│   ├── tests/
│   │   ├── test_api.py
│   │   ├── test_separator.py
│   │   └── fixtures/
│   ├── Dockerfile                   ← single image for api + jobs (entrypoint switch)
│   ├── cloudbuild.yaml              ← Cloud Build: build → push to Artifact Registry → deploy
│   ├── requirements.txt
│   ├── .env.example                 ← S3_BUCKET, AWS_*, MONGODB_URI, GCP_PROJECT_ID, TASK_QUEUE, DEFAULT_MODEL, YT_COOKIES_SECRET
│   ├── deploy/
│   │   ├── deploy.sh                ← gcloud run deploy (service) + gcloud run jobs create/update + gcloud tasks queues create + S3 bucket + lifecycle
│   │   └── README.md                ← Cloud Run + Atlas + S3 deploy steps (no VPS, no GCS)
│   └── README.md
│
└── vocal_remover_mobile/            ← Flutter Android app
    ├── lib/
    │   ├── main.dart
    │   ├── app.dart
    │   ├── core/
    │   │   ├── api_client.dart      ← dio + base url from settings
    │   │   ├── settings.dart        ← shared_preferences for backend url
    │   │   ├── theme.dart
    │   │   └── result.dart          ← sealed result types
    │   ├── data/
    │   │   ├── job.dart             ← Job model
    │   │   ├── job_dao.dart         ← sqflite
    │   │   └── models_catalog.dart  ← fetch /api/v1/models
    │   ├── features/
    │   │   ├── home/
    │   │   │   ├── home_screen.dart
    │   │   │   └── home_controller.dart
    │   │   ├── jobs/
    │   │   │   ├── jobs_screen.dart
    │   │   │   ├── job_detail_screen.dart
    │   │   │   └── jobs_controller.dart
    │   │   ├── player/
    │   │   │   └── player_screen.dart    ← just_audio
    │   │   └── settings/
    │   │       └── settings_screen.dart
    │   └── widgets/
    │       ├── progress_card.dart
    │       └── stem_tile.dart
    ├── android/                      ← generated by flutter create
    ├── test/
    ├── pubspec.yaml
    └── README.md
```

---

## 6. Processing Pipeline (per job)

```
1. Job received (api service)
   ├── upload → stream to s3://bucket/uploads/{job_id}/input.<ext> (presigned POST or direct upload via api)
   └── youtube_url → validate URL shape, enqueue immediately (download happens in Job)

2. Enqueue
   ├── insert MongoDB Atlas doc jobs {_id: job_id, status: queued, progress: 0, stage: queued}
   └── Cloud Tasks enqueue vocal-jobs → triggers Cloud Run Job execution with {job_id, model, stems}

3. YouTube download (inside Job, if applicable)
   ├── yt-dlp --dump-json → get duration, title, thumbnail (cookies from Secret Manager if set)
   ├── reject if duration > 20 min → mark failed in MongoDB
   ├── yt-dlp -f bestaudio --extract-audio --audio-format wav → /tmp/input.wav
   └── update MongoDB stage="converting"

4. Pre-process (inside Job)
   ├── ffmpeg probe → sample_rate, channels
   ├── convert to 44.1 kHz stereo wav (python-audio-separator expects this)
   └── update MongoDB stage="separating"

5. Separate (inside Job)
   ├── model already baked in image; held module-level (no download, no reload per job)
   ├── audio-separator.separate() with chosen model + stem count (UVR-MDX-NET-Inst_HQ_3 default)
   ├── writes /tmp/*.wav then uploads to s3://bucket/results/{job_id}/(vocals|instrumental).wav
   └── update MongoDB progress 0..100, stage="encoding"

6. Post-process (inside Job)
   ├── ffmpeg re-encode to mp3 192k (smaller, friendlier for mobile download)
   ├── upload mp3s to s3://bucket/results/{job_id}/
   └── update MongoDB results[] with S3 keys + size/duration

7. Done
   ├── delete s3://bucket/uploads/{job_id}/ (input)
   ├── keep s3://bucket/results/{job_id}/ for 7d (S3 lifecycle rule, configurable)
   ├── mark MongoDB status="done", finishedAt=now
   └── api's GET /results/{job_id}/{file} will now 302 to S3 presigned URL
```

**Worker tuning (Cloud Run Jobs):**
- One Job execution per separation (no long-lived workers, no idle cost).
- CPU always allocated, 2-4 vCPU / 4-8 GB per execution, timeout 900s (15 min).
- Model baked into image layer (~300 MB ONNX for two MDX-Net models) — no cold download; first inference still pays ONNX init (~5-10s).
- Module-level model cache (load once per execution, reuse if Job handles retries).
- Concurrency per Job = 1 (audio work is CPU-bound, no benefit from parallel). Scale via Cloud Tasks dispatch rate.

---

## 7. Deployment — Cloud Run Only (no VPS)

> **Console path:** Cloud Run → *Deploy a web service* (**Deploy container** / **Connect repository**) for the api service; *Create a batch job or background worker pool* (**Create job**) for workers. Creating any resource enables the **Cloud Run Admin API**.

### 7.1 Sizing (maps to Cloud Run + external services)

| Role | Service | vCPU / Config | Scaling | Notes |
|------|---------|---------------|---------|-------|
| api | Cloud Run Service | 1-2 vCPU, 1-2 GB | min 0, max 5 | Scale-to-zero, CPU throttled when idle OK. No model in api. |
| workers | Cloud Run Jobs | 2-4 vCPU, 4-8 GB | 0..10 concurrent executions | CPU **always allocated**, timeout 900s. Bake models in image. |
| storage | AWS S3 | — | — | `uploads/` lifecycle 1d, `results/` 7d. Outside GCP. |
| db | MongoDB Atlas | M0 free or M10+ | — | `jobs` collection. Outside GCP. |
| queue | Cloud Tasks | — | — | `vocal-jobs` on GCP. Cheap, triggers Jobs. |

Throughput: ~30-60 songs/h at 2-4 vCPU per job (2-3 min/song on CPU), scales with max executions.

### 7.2 One-time setup — GCP + MongoDB Atlas + AWS S3

> **Placeholders:** `<GCP_PROJECT_ID>` `<GCP_REGION>`=us-central1 `<IMAGE_TAG>` `s3://<S3_BUCKET>` `<AWS_REGION>` `<AWS_ACCESS_KEY_ID>` `<AWS_SECRET_ACCESS_KEY>` `<MONGODB_URI>`=Atlas SRV URI `<MONGODB_DB>`=vocal_remover `<CLOUD_RUN_SERVICE_ACCOUNT>` `<YT_COOKIES_SECRET>` — replace before running. No real secrets committed.


```bash
# --- GCP (Cloud Run + Cloud Tasks) ---
gcloud config set project <GCP_PROJECT_ID>
gcloud services enable run.googleapis.com cloudtasks.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
# Note: no firestore.googleapis.com, no storage.googleapis.com — DB/storage are external

gcloud artifacts repositories create vocal-remover --repository-format=docker --location=us-central1

gcloud tasks queues create vocal-jobs --location=us-central1 --max-concurrent-dispatches=10 --max-attempts=3

# Optional: Secret Manager for YouTube cookies + external secrets
# gcloud secrets create yt-cookies --data-file=cookies.txt
# gcloud secrets create mongodb-uri --data-file=<(echo -n "<MONGODB_URI>")
# gcloud secrets create aws-credentials --data-file=aws.json
# gcloud secrets add-iam-policy-binding yt-cookies --member=serviceAccount:<CLOUD_RUN_SERVICE_ACCOUNT> --role=roles/secretmanager.secretAccessor

# --- MongoDB Atlas (outside GCP) ---
# 1. Create Atlas project + M0 (free) or M10 cluster, whitelist 0.0.0.0/0 or GCP egress IPs
# 2. Create db user, copy SRV URI: <MONGODB_URI>
# 3. Create collection `jobs` in db `vocal_remover`
# Optional TTL index (complements S3 lifecycle):
#   db.jobs.createIndex({ finishedAt: 1 }, { expireAfterSeconds: 604800 })  # 7 days

# --- AWS S3 (outside GCP) ---
aws s3 mb s3://<S3_BUCKET> --region <AWS_REGION>  # e.g. <AWS_REGION>
aws s3api put-bucket-lifecycle-configuration --bucket <S3_BUCKET> --lifecycle-configuration file://s3-lifecycle.json
# s3-lifecycle.json: { "Rules": [{ "ID": "uploads-1d", "Filter": {"Prefix": "uploads/"}, "Status": "Enabled", "Expiration": {"Days": 1} }, { "ID": "results-7d", "Filter": {"Prefix": "results/"}, "Status": "Enabled", "Expiration": {"Days": 7} }] }
# CORS for presigned GETs if needed for direct browser playback
```

No UFW, no Nginx, no certbot — Cloud Run's front-end handles TLS + HTTP→HTTPS automatically. Custom domain (optional) via Cloud Run → *Manage custom domains* (Google-managed cert).
No GCS bucket, no Firestore — those are replaced by S3 + Atlas (see lifecycle/index above).

### 7.3 Container & deploy (replaces `docker-compose.yml` + `nginx/` + `setup_vps.sh`)

- **Single Dockerfile** — multi-stage, bakes `UVR-MDX-NET-Inst_HQ_3.onnx` + `Kim_Vocal_2.onnx` into `/app/models/` layer. Entrypoint switch: `api` (uvicorn) vs `worker` (python -m app.workers.separation).
- **Build & push:** `gcloud builds submit --config cloudbuild.yaml` → `us-central1-docker.pkg.dev/<GCP_PROJECT_ID>/vocal-remover/api:<IMAGE_TAG>`
  - `cloudbuild.yaml`: steps `docker build` → `docker push` → `gcloud run deploy` (api) + `gcloud run jobs update` (workers).
- **Deploy api (Service):** `gcloud run deploy vocal-remover-api --image <IMAGE> --region us-central1 --allow-unauthenticated --memory 2Gi --cpu 2 --min-instances 0 --max-instances 5 --set-env-vars S3_BUCKET=...,MONGODB_URI=...,GCP_PROJECT_ID=...,DEFAULT_MODEL=UVR-MDX-NET-Inst_HQ_3,...`
  - Alternative: Cloud Console → *Deploy a web service* → **Connect repository** (auto-build on git push) or **Deploy container** (pick Artifact Registry image).
- **Deploy workers (Jobs):** `gcloud run jobs create vocal-remover-worker --image <IMAGE> --region us-central1 --memory 8Gi --cpu 4 --task-timeout 900 --set-env-vars S3_BUCKET=...,MONGODB_URI=...,DEFAULT_MODEL=... --command "python,-m,app.workers.separation"`
  - Console: *Create a batch job or background worker pool* → **Create job**.
  - Cloud Tasks dispatches to `https://run.googleapis.com/v1/projects/<GCP_PROJECT_ID>/locations/us-central1/jobs/vocal-remover-worker:run` (or via dispatcher endpoint on api that calls `jobs.run` and injects `MONGODB_URI`/`S3_BUCKET`).
- **No `docker compose up`, no `replicas: WORKER_COUNT`, no `redis:7-alpine`, no `volumes:`** — all removed.

### 7.4 Deleted (VPS-only, not used on Cloud Run)

- `nginx/vocal_remover.conf` — removed (no Nginx). Rate limit now via `slowapi` + optional Cloud Armor.
- `deploy/setup_vps.sh` — removed (no VM bootstrap).
- `deploy/init_letsencrypt.sh` — removed (no certbot; Cloud Run manages TLS).
- `docker-compose.yml` / `WORKER_COUNT` / `REDIS_URL` — removed (replaced by Cloud Tasks + Cloud Run Jobs scaling).
- **GCS bucket** (`gsutil mb` + `gcs-lifecycle.json`) — removed (replaced by AWS S3 + `s3-lifecycle.json`).
- **Firestore** (`gcloud firestore databases create`) — removed (replaced by MongoDB Atlas + `jobs` collection + TTL index).

### 7.5 Environment (`.env.example` — Cloud Run + Atlas + S3)

```env
# App
APP_ENV=production
LOG_LEVEL=info
BASE_URL=https://<CLOUD_RUN_URL>
GCP_PROJECT_ID=<GCP_PROJECT_ID>
GCP_REGION=us-central1

# Storage — AWS S3 (outside GCP, replaces GCS + /data)
S3_BUCKET=<S3_BUCKET>
AWS_REGION=<AWS_REGION>
AWS_ACCESS_KEY_ID=<AWS_ACCESS_KEY_ID>
AWS_SECRET_ACCESS_KEY=<AWS_SECRET_ACCESS_KEY>
# Or use IAM role via Secret Manager; app reads via boto3
MAX_UPLOAD_MB=50
MAX_DURATION_S=1200
RESULT_TTL_HOURS=168
# S3 lifecycle enforces this; app also checks on read

# DB — MongoDB Atlas (outside GCP, replaces Firestore)
MONGODB_URI=<MONGODB_URI>
MONGODB_DB=vocal_remover
MONGODB_COLLECTION=jobs

# Queue — Cloud Tasks (still on GCP, cheap trigger for Cloud Run Jobs)
TASK_QUEUE=vocal-jobs
TASK_QUEUE_LOCATION=us-central1
GCP_PROJECT_ID=<GCP_PROJECT_ID>

# Models (baked into image, not downloaded at runtime)
DEFAULT_MODEL=UVR-MDX-NET-Inst_HQ_3
# Kim_Vocal_2 available as second option (vocals-only); htdemucs optional 4-stem
MODEL_DIR=/app/models

# YouTube (optional, via Secret Manager — not a file path)
YT_COOKIES_SECRET=projects/<GCP_PROJECT_ID>/secrets/<YT_COOKIES_SECRET>/versions/latest
# YT_COOKIES_FILE kept as fallback for local dev only

# Cloud Run Jobs
JOB_TIMEOUT_S=900
```

### 7.6 Local dev (unchanged)

```bash
# still works locally without GCP:
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
# workers run as: python -m app.workers.separation --job-id xxx  (or via Cloud Tasks emulator)
pytest
```

---

## 8. Flutter App — Flow

1. **First launch** → settings screen, user enters backend URL (`https://<CLOUD_RUN_URL>`).
2. **Home screen**:
   - Tabs: "File" | "YouTube URL"
   - Model picker: `2-Stem (Vocals + Instrumental)` [default] / `Vocals only` / `4-Stem`
   - Big action button: "Separate"
3. **Submit**:
   - File: pick with `file_picker`, show size, upload with `dio` showing progress.
   - YouTube: validate URL, upload as form field (server does the download).
4. **While processing** → Jobs list shows the job with live status (poll every 3 s).
5. **Job done** → tap to open detail screen; per-stem tiles with:
   - Stem name + duration + size
   - "Play" → opens in-app player (`just_audio`, streams from server)
   - "Download" → saves to device Downloads folder
   - "Share" → system share sheet
6. **History** persisted in sqflite; "Delete" removes from history (server cleanup is separate).

---

## 9. Security & Abuse Mitigation (v1, no auth) — Cloud Run

- **TLS** mandatory (Cloud Run managed cert, auto HTTP→HTTPS).
- **`slowapi` rate limit** (in app) — 10 req/min/IP for `POST /separate`, 60 r/m for reads; optional Cloud Armor policy on top.
- **Concurrency cap** — 2 concurrent jobs/IP (app-level counter in MongoDB).
- **Upload size cap** — 50 MB (FastAPI + S3).
- **Duration cap** — 20 min (server-side via ffprobe).
- **Result expiry** — S3 lifecycle (uploads 1d, results 7d) + optional MongoDB TTL index on `finishedAt` (7d).
- **No PII stored** beyond the file contents.
- **YouTube ToS** — service is for personal use; document this in app and `/about` endpoint.
- **File-type sniffing** — use `python-magic` (libmagic) not just extension.

When auth is added (v2): add API key + per-key quotas, swap to JWT-based user accounts.

---

## 10. Cost Estimate — $300 / 90 Days on Cloud Run (no VPS)

Budget: **$300 credit, expires in 90 days** — must burn it or lose it; plan for 90-day run, not 6 months.

| Item | Cost | Notes |
|------|------|-------|
| Cloud Run Service (api, 1-2 vCPU 2 GB, scale-to-zero) | ~$5-10/mo | Near-zero when idle; only pays for requests. |
| Cloud Run Jobs (workers, 2-4 vCPU 4-8 GB, CPU always allocated) | ~$15-35/mo | Pay per execution second; 1000-2000 songs/mo fits. |
| AWS S3 (uploads/results) | ~$1-3/mo | <100 GB, lifecycle deletes keep it low. Outside GCP. |
| MongoDB Atlas | ~$0 (M0 free) | M0 free tier covers this scale; M10 ~$9/mo if needed. Outside GCP. |
| Cloud Tasks | ~$0 | Free tier covers queue ops. |
| Artifact Registry + Cloud Build | ~$0-1/mo | Minimal storage/build minutes. |
| Egress | ~$2-5/mo | 100 GB covers ~2000 song downloads. |
| **Total** | **~$25-55/mo → ~$75-165 / 90 days** | Well inside $300; headroom for heavier testing or 4-stem. |

No domain required for v1 (use `*.run.app` URL); custom domain optional later via Cloud Run managed cert (no certbot cost).
No Memorystore/Firestore/GCS charges — DB/storage are outside GCP (Atlas M0 free, S3 cheap).

---

## 11. Open Decisions / Future Work (v2+)

- [ ] API key auth + per-user quotas.
- [ ] Stripe / Paymob / Fawry billing.
- [ ] iOS build (mostly free once Flutter codebase is solid).
- [ ] GPU worker pool toggle (for higher-tier users).
- [ ] Web upload UI.
- [ ] Bulk / playlist support.
- [ ] Spotify / SoundCloud URL support.
- [ ] Direct upload from a URL (S3 presigned, etc.).
- [ ] Result format options (mp3 / wav / flac, bitrate).
- [ ] Background jobs via FCM push notification (instead of polling).

---

## 12. When Ready to Deploy — Checklist (Cloud Run, 90-day $300 credit) — Phase 0 infra assumed done

- [ ] GCP project created, **Cloud Run Admin API** enabled (auto on first Cloud Run resource), billing linked to $300 trial.
- [x] One-time setup (Phase 0) — skipped per instruction: Artifact Registry repo + Cloud Tasks queue + Atlas `jobs` + S3 lifecycle assumed provisioned (placeholders filled).
- [ ] Image built & pushed: `gcloud builds submit --config cloudbuild.yaml` (or Console → *Deploy a web service* → **Connect repository**).
- [ ] `vocal-remover-api` Service deployed (Cloud Run → *Deploy a web service* → **Deploy container**), URL noted (`*.run.app`).
- [ ] `vocal-remover-worker` Job created (Cloud Run → *Create a batch job* → **Create job**), CPU always allocated, 900s timeout, models baked.
- [ ] Smoke test: `curl https://<api-url>/api/v1/health` → ok (`mongo`/`s3`/`queue`); upload sample mp3 → poll `/jobs/{id}` (MongoDB) → download stems via S3 presigned URL.
- [ ] I build the APK (`flutter build apk --release`), share file; user installs, sets backend URL = `https://<api-url>`, tests end-to-end.
- [ ] Budget check at day 30/60: Cloud Console → Billing → verify burn rate leaves headroom to 90 days; adjust worker vCPU/max executions if needed.

---

## 13. What I'll Build in This Worktree

- [x] `work_spaces/PLAN.md` — this file.
- [ ] `work_spaces/vocal_remover_backend/` — FastAPI (Cloud Run Service) + Cloud Run Jobs + MongoDB Atlas + AWS S3 + Cloud Tasks.
- [ ] `work_spaces/vocal_remover_mobile/` — Flutter Android app, builds a release APK.
- [ ] End-to-end test: upload a sample song, verify stems, generate APK.

Ready to start scaffolding. I'll begin with the backend skeleton once you give the go-ahead.

---

## Appendix A — Optional Paths

- **Redis/Memorystore + RQ** (not recommended for $300/90-day) — restores `REDIS_URL`/`WORKER_COUNT`/`rq worker` for >10k jobs/day pub/sub needs; adds $105/90 days. Not used in v1.
- **SQS instead of Cloud Tasks** — if you want queue also off-GCP: swap Cloud Tasks for SQS + have Cloud Run Jobs poll SQS. Requires a poller (worker pool or EventBridge → Cloud Run Jobs). More ops, no real saving at this scale; Cloud Tasks stays cheapest trigger for Cloud Run.
