from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # App
    APP_ENV: str = "production"
    LOG_LEVEL: str = "info"
    BASE_URL: str = "https://<CLOUD_RUN_URL>"

    # GCP
    GCP_PROJECT_ID: str = "<GCP_PROJECT_ID>"
    GCP_REGION: str = "us-central1"

    # Storage — AWS S3 (outside GCP, replaces GCS + /data)
    S3_BUCKET: str = "<S3_BUCKET>"
    AWS_REGION: str = "<AWS_REGION>"
    AWS_ACCESS_KEY_ID: str = "<AWS_ACCESS_KEY_ID>"
    AWS_SECRET_ACCESS_KEY: str = "<AWS_SECRET_ACCESS_KEY>"

    MAX_UPLOAD_MB: int = 50
    MAX_DURATION_S: int = 1200
    RESULT_TTL_HOURS: int = 168

    # DB — MongoDB Atlas (outside GCP, replaces Firestore)
    MONGODB_URI: str = "<MONGODB_URI>"
    MONGODB_DB: str = "vocal_remover"
    MONGODB_COLLECTION: str = "jobs"

    # Queue — Cloud Tasks (still on GCP)
    TASK_QUEUE: str = "vocal-jobs"
    TASK_QUEUE_LOCATION: str = "us-central1"

    # Models (baked into image, not downloaded at runtime)
    DEFAULT_MODEL: str = "UVR-MDX-NET-Inst_HQ_3"
    MODEL_DIR: str = "/app/models"

    # YouTube (optional, via Secret Manager — not a file path)
    YT_COOKIES_SECRET: str = "projects/<GCP_PROJECT_ID>/secrets/<YT_COOKIES_SECRET>/versions/latest"
    # YT_COOKIES_FILE is kept as fallback for local dev only (not loaded via BaseSettings
    # so it can be set independently without leaking into the typed settings).
    # Access via os.environ.get("YT_COOKIES_FILE") where needed.

    # Internal dispatch security
    INTERNAL_DISPATCH_TOKEN: str = "<INTERNAL_DISPATCH_TOKEN>"

    # Cloud Run Jobs
    JOB_TIMEOUT_S: int = 900


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
