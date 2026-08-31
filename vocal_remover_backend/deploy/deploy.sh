#!/usr/bin/env bash
# deploy/deploy.sh — Cloud Run (api Service + worker Job) + Cloud Tasks + S3
# Cloud Run only. No VPS, no Nginx, no GCS, no Firestore.
#
# One-time infra is assumed provisioned OR this script creates it idempotently.
# Placeholders MUST be replaced before running (env vars or .env).
#
# Required env (export them, or create .env next to this script):
#   GCP_PROJECT_ID, GCP_REGION (default us-central1), S3_BUCKET, AWS_REGION,
#   MONGODB_URI, MONGODB_DB (optional, default vocal_remover)
#   IMAGE (optional, default: us-central1-docker.pkg.dev/<GCP_PROJECT_ID>/vocal-remover/api:latest)
#
# Optional:
#   IMAGE_TAG, AR_REPO, TASK_QUEUE (default vocal-jobs), YT_COOKIES_SECRET
#
# Usage:
#   cp ../.env.example .env   # fill placeholders, then:
#   ./deploy/deploy.sh
#   # or:
#   GCP_PROJECT_ID=my-proj S3_BUCKET=my-bucket MONGODB_URI='mongodb+srv://...' ./deploy/deploy.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load .env next to deploy.sh if present, then .env at backend root
for f in "$SCRIPT_DIR/.env" "$ROOT_DIR/.env"; do
  if [[ -f "$f" ]]; then
    echo "Loading env from $f"
    set -a; source "$f"; set +a
  fi
done

GCP_PROJECT_ID="${GCP_PROJECT_ID:-<GCP_PROJECT_ID>}"
GCP_REGION="${GCP_REGION:-us-central1}"
S3_BUCKET="${S3_BUCKET:-<S3_BUCKET>}"
AWS_REGION="${AWS_REGION:-<AWS_REGION>}"
MONGODB_URI="${MONGODB_URI:-<MONGODB_URI>}"
MONGODB_DB="${MONGODB_DB:-vocal_remover}"
TASK_QUEUE="${TASK_QUEUE:-vocal-jobs}"
AR_REPO="${AR_REPO:-vocal-remover}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
YT_COOKIES_SECRET="${YT_COOKIES_SECRET:-}"
IMAGE="${IMAGE:-${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${AR_REPO}/api:${IMAGE_TAG}}"
CLOUD_RUN_SERVICE_ACCOUNT="${CLOUD_RUN_SERVICE_ACCOUNT:-}"

warn_placeholders() {
  local bad=0
  for v in GCP_PROJECT_ID S3_BUCKET MONGODB_URI; do
    val="${!v:-}"
    if [[ "$val" == \<* ]] || [[ -z "$val" ]]; then
      echo "WARNING: $v is still a placeholder or empty: '$val' — replace it before deploying." >&2
      bad=1
    fi
  done
  if [[ "${AWS_REGION:-}" == \<* ]] || [[ -z "${AWS_REGION:-}" ]]; then
    echo "WARNING: AWS_REGION is placeholder/empty — S3 lifecycle/CORS may be skipped." >&2
  fi
  if [[ $bad -eq 1 ]]; then
    echo "Placeholders detected. Fill them in .env or env vars, then re-run." >&2
    echo "Continuing anyway in 5s (Ctrl+C to abort)..." >&2
    sleep 5
  fi
}

warn_placeholders

echo "==> Config"
echo "    GCP_PROJECT_ID=$GCP_PROJECT_ID  GCP_REGION=$GCP_REGION"
echo "    S3_BUCKET=$S3_BUCKET  AWS_REGION=${AWS_REGION:-<AWS_REGION>}"
echo "    MONGODB_DB=$MONGODB_DB  TASK_QUEUE=$TASK_QUEUE"
echo "    IMAGE=$IMAGE"

# ── GCP: enable APIs ────────────────────────────────────────────────────────
echo ""
echo "==> Enabling GCP APIs (run, cloudtasks, artifactregistry, secretmanager)"
gcloud config set project "$GCP_PROJECT_ID" >/dev/null
gcloud services enable \
  run.googleapis.com \
  cloudtasks.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com || true

# ── Artifact Registry repo (idempotent) ─────────────────────────────────────
echo ""
echo "==> Ensuring Artifact Registry repo: $AR_REPO ($GCP_REGION)"
if ! gcloud artifacts repositories describe "$AR_REPO" --location="$GCP_REGION" --project="$GCP_PROJECT_ID" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$AR_REPO" \
    --repository-format=docker \
    --location="$GCP_REGION" \
    --project="$GCP_PROJECT_ID"
else
  echo "    Repo $AR_REPO already exists — skipping create."
fi

# ── Build note (image is expected to already be pushed; cloudbuild.yaml does this) ─
echo ""
echo "==> Image: $IMAGE"
echo "    If not yet pushed, run: gcloud builds submit --config cloudbuild.yaml --substitutions=_GCP_PROJECT_ID=$GCP_PROJECT_ID,_IMAGE_TAG=$IMAGE_TAG,_GCP_REGION=$GCP_REGION,_S3_BUCKET=$S3_BUCKET,_MONGODB_URI=\"\$MONGODB_URI\""

# ── Cloud Run Service (api) ─────────────────────────────────────────────────
echo ""
echo "==> Deploying Cloud Run Service: vocal-remover-api"
ENV_VARS="S3_BUCKET=${S3_BUCKET},MONGODB_URI=${MONGODB_URI},MONGODB_DB=${MONGODB_DB},GCP_PROJECT_ID=${GCP_PROJECT_ID},GCP_REGION=${GCP_REGION},MODEL_DIR=/app/models,DEFAULT_MODEL=UVR-MDX-NET-Inst_HQ_3,TASK_QUEUE=${TASK_QUEUE},TASK_QUEUE_LOCATION=${GCP_REGION}"
if [[ -n "$YT_COOKIES_SECRET" && "$YT_COOKIES_SECRET" != \<* ]]; then
  ENV_VARS="${ENV_VARS},YT_COOKIES_SECRET=${YT_COOKIES_SECRET}"
fi

gcloud run deploy vocal-remover-api \
  --image="$IMAGE" \
  --region="$GCP_REGION" \
  --project="$GCP_PROJECT_ID" \
  --allow-unauthenticated \
  --memory=2Gi \
  --cpu=2 \
  --min-instances=0 \
  --max-instances=5 \
  --set-env-vars="$ENV_VARS"

# ── Cloud Run Job (workers) — create or update ──────────────────────────────
echo ""
echo "==> Deploying Cloud Run Job: vocal-remover-worker (create or update)"
JOB_ENV_VARS="S3_BUCKET=${S3_BUCKET},MONGODB_URI=${MONGODB_URI},MONGODB_DB=${MONGODB_DB},GCP_PROJECT_ID=${GCP_PROJECT_ID},GCP_REGION=${GCP_REGION},MODEL_DIR=/app/models,DEFAULT_MODEL=UVR-MDX-NET-Inst_HQ_3,JOB_TIMEOUT_S=900"
if [[ -n "$YT_COOKIES_SECRET" && "$YT_COOKIES_SECRET" != \<* ]]; then
  JOB_ENV_VARS="${JOB_ENV_VARS},YT_COOKIES_SECRET=${YT_COOKIES_SECRET}"
fi

if gcloud run jobs describe vocal-remover-worker --region="$GCP_REGION" --project="$GCP_PROJECT_ID" >/dev/null 2>&1; then
  echo "    Job exists — updating."
  gcloud run jobs update vocal-remover-worker \
    --image="$IMAGE" \
    --region="$GCP_REGION" \
    --project="$GCP_PROJECT_ID" \
    --memory=8Gi \
    --cpu=4 \
    --task-timeout=900 \
    --set-env-vars="$JOB_ENV_VARS"
else
  echo "    Job not found — creating."
  gcloud run jobs create vocal-remover-worker \
    --image="$IMAGE" \
    --region="$GCP_REGION" \
    --project="$GCP_PROJECT_ID" \
    --memory=8Gi \
    --cpu=4 \
    --task-timeout=900 \
    --set-env-vars="$JOB_ENV_VARS" \
    --command="python,-m,app.workers.separation"
fi

# ── Cloud Tasks queue (idempotent) ──────────────────────────────────────────
echo ""
echo "==> Ensuring Cloud Tasks queue: $TASK_QUEUE ($GCP_REGION)"
if ! gcloud tasks queues describe "$TASK_QUEUE" --location="$GCP_REGION" --project="$GCP_PROJECT_ID" >/dev/null 2>&1; then
  gcloud tasks queues create "$TASK_QUEUE" \
    --location="$GCP_REGION" \
    --project="$GCP_PROJECT_ID" \
    --max-concurrent-dispatches=10 \
    --max-attempts=3
else
  echo "    Queue $TASK_QUEUE already exists — skipping create."
  # Optionally reconcile dispatch settings:
  # gcloud tasks queues update "$TASK_QUEUE" --location="$GCP_REGION" --max-concurrent-dispatches=10 --max-attempts=3
fi

# ── AWS S3 bucket + lifecycle (idempotent, skipped if placeholders) ─────────
echo ""
if [[ "$S3_BUCKET" == \<* ]] || [[ -z "$S3_BUCKET" ]]; then
  echo "==> Skipping S3 bucket creation (S3_BUCKET is placeholder/empty)."
elif ! command -v aws >/dev/null 2>&1; then
  echo "==> Skipping S3 setup: aws CLI not found. Install it and run:"
  echo "    aws s3 mb s3://$S3_BUCKET --region ${AWS_REGION:-us-east-1}"
  echo "    aws s3api put-bucket-lifecycle-configuration --bucket $S3_BUCKET --lifecycle-configuration file://$SCRIPT_DIR/s3-lifecycle.json"
else
  echo "==> Ensuring S3 bucket: s3://$S3_BUCKET"
  if aws s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null; then
    echo "    Bucket s3://$S3_BUCKET already exists — skipping mb."
  else
    if [[ -n "${AWS_REGION:-}" && "$AWS_REGION" != \<* ]]; then
      aws s3 mb "s3://$S3_BUCKET" --region "$AWS_REGION"
    else
      aws s3 mb "s3://$S3_BUCKET"
    fi
  fi
  echo "==> Applying S3 lifecycle (uploads 1d, results 7d) from s3-lifecycle.json"
  aws s3api put-bucket-lifecycle-configuration \
    --bucket "$S3_BUCKET" \
    --lifecycle-configuration "file://$SCRIPT_DIR/s3-lifecycle.json"
  echo "    Lifecycle applied."
fi

echo ""
echo "==> Done."
echo "    API:    https://vocal-remover-api-xxxxx-${GCP_REGION}.a.run.app  (see: gcloud run services describe vocal-remover-api --region $GCP_REGION --format='value(status.url)')"
echo "    Health: curl \$(gcloud run services describe vocal-remover-api --region $GCP_REGION --format='value(status.url)')/api/v1/health"
echo "    Jobs:   gcloud run jobs describe vocal-remover-worker --region $GCP_REGION"
echo "    Queue:  gcloud tasks queues describe $TASK_QUEUE --location $GCP_REGION"
if [[ "$S3_BUCKET" != \<* && -n "$S3_BUCKET" ]]; then
  echo "    S3:     s3://$S3_BUCKET  (lifecycle: uploads 1d, results 7d)"
fi
