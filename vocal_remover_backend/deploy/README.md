# Deploy — Cloud Run + Atlas + S3

Idempotent deploy for Cloud Run only (no VPS, no GCS, no Firestore).

## What this deploys

- **Cloud Run Service** `vocal-remover-api` — FastAPI, 2 Gi / 2 vCPU, 0–5 instances, public.
- **Cloud Run Job** `vocal-remover-worker` — ONNX separation, 8 Gi / 4 vCPU, 900 s timeout, `python -m app.workers.separation`.
- **Cloud Tasks** queue `vocal-jobs` — `us-central1`, 10 concurrent, 3 attempts.
- **S3** bucket + lifecycle (`uploads/` 1 d, `results/` 7 d) via `s3-lifecycle.json`.

## Quick start

```bash
cp ../.env.example .env   # or deploy/.env — fill <PLACEHOLDERS>
# then:
./deploy.sh
```

Or via Cloud Build (builds image first):

```bash
gcloud builds submit --config ../cloudbuild.yaml \
  --substitutions=_GCP_PROJECT_ID=<GCP_PROJECT_ID>,_IMAGE_TAG=$(git rev-parse --short HEAD),_GCP_REGION=us-central1,_S3_BUCKET=<S3_BUCKET>,_MONGODB_URI="<MONGODB_URI>"
```

Required env: `GCP_PROJECT_ID`, `S3_BUCKET`, `MONGODB_URI`, `AWS_REGION`. Optional: `IMAGE` / `IMAGE_TAG`, `AR_REPO`, `TASK_QUEUE`, `YT_COOKIES_SECRET`. See `../.env.example`.
