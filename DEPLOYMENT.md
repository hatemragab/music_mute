# Deployment Guide — Vocal Remover Service

Step-by-step guide for deploying the backend to Google Cloud Run (with AWS S3 and MongoDB Atlas) and building the Flutter Android APK.

---

## Prerequisites

- **AWS Account**: S3 bucket and IAM credentials with S3 read/write permissions.
- **MongoDB Atlas**: Cluster URI with read/write credentials.
- **Google Cloud Platform**: Project with billing linked ($300 trial).
- **Local CLI Tools**:
  - `gcloud` (authenticated: `gcloud auth login`)
  - `aws` CLI (configured: `aws configure`)
  - `flutter` SDK (3.x) & Android build tools

---

## Phase 1: External Infrastructure (AWS & MongoDB)

### 1. AWS S3 Bucket Setup

```bash
# Set your bucket name and region
export S3_BUCKET="your-vocal-remover-bucket"
export AWS_REGION="us-east-1"

# Create bucket
aws s3api create-bucket \
  --bucket $S3_BUCKET \
  --region $AWS_REGION

# Apply lifecycle configuration (1-day retention for uploads, 7-day retention for results)
aws s3api put-bucket-lifecycle-configuration \
  --bucket $S3_BUCKET \
  --lifecycle-configuration file://vocal_remover_backend/deploy/s3-lifecycle.json
```

### 2. MongoDB Atlas Setup

1. Create a free M0 cluster on [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
2. Create a database user and record the password.
3. In **Network Access**, allow access from anywhere (`0.0.0.0/0`) for Cloud Run connectivity.
4. Copy the connection string:
   ```
   mongodb+srv://<username>:<password>@cluster0.mongodb.net/?retryWrites=true&w=majority
   ```

---

## Phase 2: Google Cloud Platform Setup

### 1. Configure GCP Project & Enable APIs

```bash
export GCP_PROJECT_ID="your-gcp-project-id"
export GCP_REGION="us-central1"

# Set project
gcloud config set project $GCP_PROJECT_ID

# Enable required Google APIs
gcloud services enable \
  run.googleapis.com \
  cloudtasks.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com
```

### 2. Create Artifact Registry & Cloud Tasks Queue

```bash
# Create Artifact Registry docker repository
gcloud artifacts repositories create vocal-remover \
  --repository-format=docker \
  --location=$GCP_REGION \
  --description="Vocal remover images"

# Create Cloud Tasks queue for separation jobs
gcloud tasks queues create vocal-jobs \
  --location=$GCP_REGION \
  --max-concurrent-dispatches=5 \
  --max-attempts=3
```

---

## Phase 3: Build & Deploy Backend

### 1. Build and Push Container Image

```bash
cd vocal_remover_backend

export IMAGE="$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/vocal-remover/vocal-remover:latest"

# Build image with baked ONNX models via Cloud Build
gcloud builds submit --tag $IMAGE .
```

### 2. Deploy FastAPI Service (Cloud Run Service)

```bash
gcloud run deploy vocal-remover-api \
  --image $IMAGE \
  --region $GCP_REGION \
  --platform managed \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --concurrency 80 \
  --timeout 300 \
  --set-env-vars "\
APP_ENV=production,\
GCP_PROJECT_ID=$GCP_PROJECT_ID,\
GCP_REGION=$GCP_REGION,\
S3_BUCKET=$S3_BUCKET,\
AWS_REGION=$AWS_REGION,\
AWS_ACCESS_KEY_ID=YOUR_AWS_ACCESS_KEY_ID,\
AWS_SECRET_ACCESS_KEY=YOUR_AWS_SECRET_ACCESS_KEY,\
MONGODB_URI=YOUR_MONGODB_URI,\
MONGODB_DB=vocal_remover,\
TASK_QUEUE=vocal-jobs,\
TASK_QUEUE_LOCATION=$GCP_REGION,\
DEFAULT_MODEL=UVR-MDX-NET-Inst_HQ_3,\
MODEL_DIR=/app/models"
```

### 3. Create Batch Worker (Cloud Run Job)

```bash
gcloud run jobs create vocal-remover-worker \
  --image $IMAGE \
  --region $GCP_REGION \
  --memory 8Gi \
  --cpu 4 \
  --task-timeout 900 \
  --command "python" \
  --args "-m,app.workers.separation" \
  --set-env-vars "\
APP_ENV=production,\
GCP_PROJECT_ID=$GCP_PROJECT_ID,\
S3_BUCKET=$S3_BUCKET,\
AWS_REGION=$AWS_REGION,\
AWS_ACCESS_KEY_ID=YOUR_AWS_ACCESS_KEY_ID,\
AWS_SECRET_ACCESS_KEY=YOUR_AWS_SECRET_ACCESS_KEY,\
MONGODB_URI=YOUR_MONGODB_URI,\
MONGODB_DB=vocal_remover,\
MODEL_DIR=/app/models"
```

---

## Phase 4: Verification & Smoke Test

```bash
# 1. Retrieve the public URL for the API
export API_URL=$(gcloud run services describe vocal-remover-api --region $GCP_REGION --format='value(status.url)')

# 2. Check health endpoint
curl -s "$API_URL/api/v1/health" | jq .
# Expected output:
# {
#   "status": "ok",
#   "mongo": "ok",
#   "s3": "ok",
#   "queue": "ok",
#   "models_baked": ["Kim_Vocal_2.onnx", "UVR-MDX-NET-Inst_HQ_3.onnx"]
# }

# 3. Verify models catalog
curl -s "$API_URL/api/v1/models" | jq .
```

---

## Phase 5: Build & Configure Mobile App

```bash
cd ../vocal_remover_mobile

# 1. Install dependencies
flutter pub get

# 2. Build release APK
flutter build apk --release

# 3. Locate built APK
# Output path: build/app/outputs/flutter-apk/app-release.apk

# 4. Install onto Android device (via USB / adb)
adb install build/app/outputs/flutter-apk/app-release.apk
```

### In-App Configuration
1. Launch **Vocal Remover** on Android device.
2. Tap the **Settings** (gear) icon in the top right.
3. Set **Backend URL** to `https://<YOUR-CLOUD-RUN-URL>` (e.g. `https://vocal-remover-api-xxxxx-uc.a.run.app`).
4. Tap **Save**.
5. Submit an audio file or YouTube URL from the Home screen.
