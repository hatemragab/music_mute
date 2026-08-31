# Vocal Remover Backend — Cloud Run + Atlas + S3

CPU-only vocal separation. FastAPI on **Cloud Run Service** + **Cloud Run Jobs** (ONNX), **MongoDB Atlas** for job state, **AWS S3** for audio, **Cloud Tasks** queue `vocal-jobs`. No GCS, no Firestore, no VPS.

See root [`PLAN.md`](../PLAN.md) §7 for full deployment plan.

## One-time setup (placeholders → real values)

```bash
# 0) Fill env — copy .env.example → .env and replace all <PLACEHOLDERS>
cp .env.example .env   # then edit: GCP_PROJECT_ID, S3_BUCKET, MONGODB_URI, AWS_*, etc.

# 1) GCP — enable APIs, create Artifact Registry + queue (or run deploy/deploy.sh)
gcloud config set project <GCP_PROJECT_ID>
gcloud services enable run.googleapis.com cloudtasks.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
gcloud artifacts repositories create vocal-remover --repository-format=docker --location=us-central1
gcloud tasks queues create vocal-jobs --location=us-central1 --max-concurrent-dispatches=10 --max-attempts=3

# 2) MongoDB Atlas (outside GCP)
# Create M0 free cluster → db user → SRV URI → collection `vocal_remover.jobs`
# Optional TTL (complements S3 lifecycle):
#   db.jobs.createIndex({ finishedAt: 1 }, { expireAfterSeconds: 604800 })

# 3) AWS S3 (outside GCP)
aws s3 mb s3://<S3_BUCKET> --region <AWS_REGION>
aws s3api put-bucket-lifecycle-configuration --bucket <S3_BUCKET> \
  --lifecycle-configuration file://deploy/s3-lifecycle.json
# s3-lifecycle.json: uploads/ 1d, results/ 7d
```

Optional secrets via Secret Manager (cookies, Atlas URI, AWS creds):

```bash
gcloud secrets create yt-cookies --data-file=cookies.txt
gcloud secrets create mongodb-uri --data-file=<(echo -n "<MONGODB_URI>")
gcloud secrets add-iam-policy-binding yt-cookies \
  --member=serviceAccount:<CLOUD_RUN_SERVICE_ACCOUNT> --role=roles/secretmanager.secretAccessor
```

## Deploy

### Via Cloud Build (recommended — build → push → deploy api + workers)

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_GCP_PROJECT_ID=<GCP_PROJECT_ID>,_IMAGE_TAG=$(git rev-parse --short HEAD),_GCP_REGION=us-central1,_S3_BUCKET=<S3_BUCKET>,_MONGODB_URI="<MONGODB_URI>"
```

Deploy steps inside `cloudbuild.yaml`:
1. `docker build -t us-central1-docker.pkg.dev/<GCP_PROJECT_ID>/vocal-remover/api:<IMAGE_TAG> .`
2. `docker push` → Artifact Registry
3. `gcloud run deploy vocal-remover-api --image ... --region us-central1 --allow-unauthenticated --memory 2Gi --cpu 2 --min-instances 0 --max-instances 5`
4. `gcloud run jobs update|create vocal-remover-worker --image ... --region us-central1 --memory 8Gi --cpu 4 --task-timeout 900 --command "python,-m,app.workers.separation"`

### Via deploy script (idempotent, no Cloud Build)

```bash
# export env or fill deploy/.env / .env, then:
./deploy/deploy.sh
# Does: enable APIs → ensure AR repo → gcloud run deploy (api) →
#       gcloud run jobs create/update (worker) → ensure Cloud Tasks queue →
#       aws s3 mb + put-bucket-lifecycle-configuration
```

### Console alternatives

- API: Cloud Run → *Deploy a web service* → **Deploy container** / **Connect repository**.
- Workers: Cloud Run → *Create a batch job or background worker pool* → **Create job** (CPU always allocated, 900 s timeout, models baked).

## Verify

```bash
API_URL=$(gcloud run services describe vocal-remover-api --region us-central1 --format='value(status.url)')
curl "$API_URL/api/v1/health"
# → {"status":"ok","mongo":"ok","s3":"ok","queue":"ok","models_baked":[...]}

curl -F file=@sample.mp3 -F model=UVR-MDX-NET-Inst_HQ_3 -F stems=2stems "$API_URL/api/v1/separate"
# → {"job_id":"...","status":"queued"}
curl "$API_URL/api/v1/jobs/<job_id>"   # poll every 3s (progress/stage/results)
curl -L "$API_URL/api/v1/results/<job_id>/vocals.mp3" -o vocals.mp3  # 302 → S3 presigned URL (15 min)
```

## Local dev

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
# Worker (single job, no Cloud Tasks):
python -m app.workers.separation --job-id <id>
pytest
pytest tests/test_api.py::test_name -v
ruff check . && ruff format .   # if configured
```

Env for local dev: `YT_COOKIES_FILE` (file path) is the fallback; on Cloud Run use `YT_COOKIES_SECRET` (Secret Manager resource name). `MODEL_DIR=/app/models`, `DEFAULT_MODEL=UVR-MDX-NET-Inst_HQ_3`.

## Layout

```
Dockerfile              # multi-stage (base → models placeholder → final), api CMD uvicorn, worker via --command override
cloudbuild.yaml         # build → push → gcloud run deploy (api) + jobs update/create (worker)
deploy/deploy.sh        # idempotent gcloud/aws deploy (set -e, placeholder warnings)
deploy/s3-lifecycle.json# uploads 1d, results 7d
```
