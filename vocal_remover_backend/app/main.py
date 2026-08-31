from __future__ import annotations

import logging
import os
import re
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.config import get_settings
from app.logging import setup_logging

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lifespan + app factory
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Best-effort index creation
    try:
        from app.db import ensure_indexes

        await ensure_indexes()
        logger.info("ensure_indexes completed")
    except Exception as e:
        logger.warning("ensure_indexes failed (best-effort): %s", e)
    yield


def _get_limiter() -> Limiter:
    return Limiter(key_func=get_remote_address, default_limits=[])


limiter = _get_limiter()

app = FastAPI(title="Vocal Remover API", version="0.1.0", lifespan=lifespan)
app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)

# CORS allow all for mobile (no credentials needed)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RateLimitExceeded)
async def _rate_limit_handler(request: Request, exc: RateLimitExceeded):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded. Try again later."})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ALLOWED_MODELS = ("UVR-MDX-NET-Inst_HQ_3", "Kim_Vocal_2", "htdemucs")
ALLOWED_STEMS = ("vocals", "2stems", "4stems")

YOUTUBE_HOSTS = ("youtube.com", "youtu.be", "m.youtube.com", "www.youtube.com", "music.youtube.com")

MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB; overridden by settings.MAX_UPLOAD_MB at request time

# Extensions we accept (also validated via magic)
_ALLOWED_EXTS = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus", ".aac", ".wma", ".aiff", ".aif", ".mp4", ".mov", ".mkv", ".webm"}


def _is_youtube_url(url: str) -> bool:
    from app.services.youtube import validate_youtube_url

    return validate_youtube_url(url)


def _client_ip(request: Request) -> str:
    """Best-effort client IP for job doc.

    X-Forwarded-For is spoofable when Cloud Run is called directly without
    an L7 fronting proxy that strips it, but the primary per-IP gate is
    slowapi's get_remote_address rate limiter (evaluated inline). This value
    is only stored on the job doc for observability and as a secondary
    best-effort concurrent check (see app/jobs.py:check_concurrent_limit).
    For a strict fix: deploy behind Cloud Armor / trusted proxy and use the
    last XFF hop or request.client.host with forwarded_allow_ips set.
    """
    # Use last hop if present? For v1 we keep first-hop with explicit docs;
    # do NOT treat XFF as authoritative. Fall back to TCP peer.
    xff = request.headers.get("x-forwarded-for")
    if xff:
        # Use the left-most (client-claimed) only as best-effort; note spoofability.
        # Keep behavior stable for v1; the rate limiter is the real gate.
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _settings_default_model() -> str:
    try:
        return get_settings().DEFAULT_MODEL or "UVR-MDX-NET-Inst_HQ_3"
    except Exception:
        return "UVR-MDX-NET-Inst_HQ_3"


def _max_upload_bytes() -> int:
    try:
        return int(get_settings().MAX_UPLOAD_MB) * 1024 * 1024
    except Exception:
        return MAX_UPLOAD_BYTES


def _magic_ok(content: bytes, filename: str | None) -> bool:
    """Use python-magic to sniff file type. Allow common audio mimetypes + fallback to extension."""
    # If no content, fail open to extension check only (some uploads may be empty sniff window)
    if not content:
        if filename:
            return Path(filename).suffix.lower() in _ALLOWED_EXTS
        return False
    try:
        import magic  # type: ignore

        mime = magic.from_buffer(content[:8192], mime=True)
        if mime in ("text/plain", "text/html", "application/json", "application/octet-stream"):
            return False
        if mime and mime.startswith("text/"):
            return False
        # Allow audio/*, video/* and specific audio containers
        if mime and (
            mime.startswith("audio/")
            or mime.startswith("video/")
            or mime in ("application/ogg", "application/x-flac")
        ):
            return True
        # Fall back to extension for magic misses (e.g., some m4a probed as application/mp4)
        if filename and Path(filename).suffix.lower() in _ALLOWED_EXTS:
            return True
        # If magic says audio/video, accept even with odd extension
        # Otherwise reject
        logger.info("magic check: mime=%s filename=%s -> reject", mime, filename)
        return False
    except ImportError:
        logger.warning("python-magic not installed, skipping magic check")
        if filename:
            return Path(filename).suffix.lower() in _ALLOWED_EXTS
        return True
    except Exception as e:
        logger.warning("magic check failed: %s", e)
        if filename:
            return Path(filename).suffix.lower() in _ALLOWED_EXTS
        return True


def _models_baked() -> list[str]:
    model_dir = Path(get_settings().MODEL_DIR) if _has_settings() else Path("/app/models")
    try:
        if not model_dir.exists():
            return []
        return sorted([p.name for p in model_dir.iterdir() if p.is_file()])
    except Exception:
        return []


def _has_settings() -> bool:
    try:
        get_settings()
        return True
    except Exception:
        return False


def _doc_to_job_response(doc: dict) -> dict:
    """Map MongoDB doc (Atlas or in-memory fallback) to JobResponse shape.

    Handles fallback store docs which use the same schema as Atlas docs: the
    fallback path in app/jobs.py writes {job_id, _id, status, progress, stage,
    results, ...} so this function works for both without branching.
    """
    from app.storage import presigned_get_url, result_key  # noqa: F401 (kept for future presigned expansion)

    job_id = doc.get("job_id") or doc.get("_id") or ""
    # Normalize results: stored results may be [{stem, key}|{stem, url, size_bytes, duration_s}]
    raw_results = doc.get("results") or []
    results = []
    for r in raw_results:
        if not isinstance(r, dict):
            continue
        stem = r.get("stem", "unknown")
        # If stored url is already an S3 presigned URL or path, keep url; if key, generate presigned
        url = r.get("url")
        key = r.get("key") or r.get("s3_key")
        size = r.get("size_bytes") or r.get("size")
        dur = r.get("duration_s") or r.get("duration")
        if not url and key:
            # key like results/{job_id}/vocals.mp3
            filename = Path(key).name
            url = f"/api/v1/results/{job_id}/{filename}"
            # Optionally try presigned directly, but spec says GET /results/{job}/{file} does 302 —
            # so keep relative url here; frontend can follow redirect.
        elif not url:
            # Try to infer from stem
            url = f"/api/v1/results/{job_id}/{stem}.mp3"
        results.append({"stem": stem, "url": url, "size_bytes": size, "duration_s": dur})

    # Coerce datetimes
    created = doc.get("created_at") or doc.get("createdAt")
    finished = doc.get("finished_at") or doc.get("finishedAt")

    pval = doc.get("progress")
    try:
        progress = int(pval) if pval is not None else 0
    except (TypeError, ValueError):
        progress = 0
    # Stems: stored as "2stems"/"vocals" string (fallback + Atlas both use string); API returns list[str]
    sval = doc.get("stems")
    if isinstance(sval, list):
        stems_val = sval
    elif isinstance(sval, str) and sval:
        stems_val = [sval]
    else:
        stems_val = None
    return {
        "job_id": str(job_id),
        "status": doc.get("status", "queued"),
        "progress": progress,
        "stage": doc.get("stage", doc.get("status", "queued")),
        "model": doc.get("model"),
        "stems": stems_val,
        "results": results,
        "error": doc.get("error"),
        "created_at": created,
        "finished_at": finished,
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/api/v1/health")
async def health():
    from app.db import is_fallback_mode, ping as mongo_ping
    from app.storage import head_bucket_ok, is_s3_configured

    settings = get_settings()

    # Mongo
    try:
        if is_fallback_mode():
            mongo_status = "ok (fallback in-memory)"
        else:
            await mongo_ping()
            mongo_status = "ok"
    except Exception as e:
        logger.warning("health mongo ping failed: %s", e)
        mongo_status = f"error: {e}"

    # S3
    try:
        if not is_s3_configured():
            s3_status = "degraded (S3 not configured)"
        else:
            s3_status = "ok" if head_bucket_ok() else "error: head_bucket failed"
    except Exception as e:
        s3_status = f"error: {e}"

    # Queue
    try:
        # Lightweight check: try to import and create a client without making a call.
        # If GCP creds missing, report degraded not hard error.
        import importlib.util

        if importlib.util.find_spec("google.cloud.tasks_v2") is None:
            queue_status = "degraded (google-cloud-tasks not installed)"
        elif str(settings.GCP_PROJECT_ID).startswith("<") or "GCP_PROJECT" in str(settings.GCP_PROJECT_ID):
            queue_status = "degraded (GCP_PROJECT_ID not configured)"
        else:
            # Try a non-mutating call only if creds likely present; otherwise mark ok/degraded.
            # We avoid an actual API call to keep health cheap — just check client can be constructed.
            from google.cloud import tasks_v2  # type: ignore

            try:
                _ = tasks_v2.CloudTasksClient()
                queue_status = "ok"
            except Exception as ce:
                queue_status = f"degraded: {ce}"
    except Exception as e:
        queue_status = f"error: {e}"

    models_baked = _models_baked()

    ok = all(s == "ok" or s.startswith("ok ") for s in [mongo_status, s3_status, queue_status])
    return {
        "status": "ok" if ok else "degraded",
        "mongo": mongo_status,
        "s3": s3_status,
        "queue": queue_status,
        "models_baked": models_baked,
    }


@app.get("/api/v1/models")
async def list_models():
    from app.models import MODELS_CATALOG

    return MODELS_CATALOG


@app.post("/api/v1/separate", status_code=202)
@limiter.limit("10/minute")
async def separate(
    request: Request,
    file: UploadFile | None = File(default=None),
    youtube_url: str | None = Form(default=None),
    model: str = Form(default=""),
    stems: str = Form(default="2stems"),
):
    # Normalize defaults
    default_model = _settings_default_model()
    if not model or not model.strip():
        model = default_model
    model = model.strip()
    stems = (stems or "2stems").strip()

    if model not in ALLOWED_MODELS:
        raise HTTPException(status_code=400, detail=f"Invalid model '{model}'. Choices: {', '.join(ALLOWED_MODELS)}")
    if stems not in ALLOWED_STEMS:
        raise HTTPException(status_code=400, detail=f"Invalid stems '{stems}'. Choices: {', '.join(ALLOWED_STEMS)}")

    has_file = file is not None and file.filename not in (None, "")
    has_url = youtube_url is not None and youtube_url.strip() != ""

    if has_file and has_url:
        raise HTTPException(status_code=400, detail="Provide exactly one of 'file' or 'youtube_url', not both.")
    if not has_file and not has_url:
        raise HTTPException(status_code=400, detail="Provide exactly one of 'file' or 'youtube_url'.")

    # Concurrent limit per IP (2)
    ip = _client_ip(request)
    try:
        from app.jobs import check_concurrent_limit

        allowed = await check_concurrent_limit(ip)
        if not allowed:
            raise HTTPException(status_code=429, detail="Too many concurrent jobs for this IP (limit 2). Try again later.")
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("check_concurrent_limit failed: %s", e)

    job_id = uuid.uuid4().hex[:12]
    max_bytes = _max_upload_bytes()

    if has_file:
        assert file is not None
        # Read file bytes (size cap)
        # Use streaming read to enforce cap before loading fully into memory for S3
        chunks: list[bytes] = []
        total = 0
        # Read in 1MB chunks
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(status_code=400, detail=f"File too large. Max {max_bytes // (1024*1024)} MB.")
            chunks.append(chunk)
        content = b"".join(chunks)

        # Magic check
        if not _magic_ok(content[:8192] if content else b"", file.filename):
            raise HTTPException(status_code=400, detail="File type not allowed. Upload an audio file (mp3, wav, flac, m4a, ogg, opus).")

        # Determine title from filename
        title = file.filename or f"upload-{job_id}"
        ext = Path(title).suffix or ".mp3"

        # Upload to S3 (best-effort; fallback logs)
        try:
            from app.storage import get_s3_client, s3_bucket, upload_key

            c = get_s3_client()
            if c is not None:
                key = upload_key(job_id, f"input{ext}")
                # Use put_object for simplicity in scaffold; real may stream
                c.put_object(Bucket=s3_bucket(), Key=key, Body=content)
                logger.info("S3 upload %s (%d bytes) for job %s", key, total, job_id)
            else:
                logger.info("S3 not configured, skipping upload for job %s (dev fallback)", job_id)
        except Exception as e:
            logger.warning("S3 upload failed for job %s: %s", job_id, e)
            # Still proceed — worker may handle missing S3 in dev

        source = "upload"
    else:
        # youtube_url path
        assert youtube_url is not None
        youtube_url = youtube_url.strip()
        if not _is_youtube_url(youtube_url):
            raise HTTPException(status_code=400, detail="Invalid youtube_url. Must be a youtube.com / youtu.be URL.")
        # Reject obviously non-URL or too long
        if len(youtube_url) > 500:
            raise HTTPException(status_code=400, detail="youtube_url too long.")
        title = youtube_url  # worker will replace with video title after yt-dlp --dump-json
        source = "youtube"
        # No file content to store; worker will download via yt-dlp

    # Create MongoDB doc + enqueue
    try:
        from app.jobs import create_job_doc, enqueue_task

        await create_job_doc(job_id=job_id, ip=ip, model=model, stems=stems, source=source, title=title)
        # Enqueue Cloud Tasks (best-effort; logs warning if GCP missing)
        try:
            await enqueue_task(job_id=job_id, model=model, stems=stems)
        except Exception as e:
            logger.warning("enqueue_task failed for %s: %s", job_id, e)
    except Exception as e:
        logger.exception("Failed to create job %s: %s", job_id, e)
        raise HTTPException(status_code=500, detail="Failed to create job. Try again.")

    return {"job_id": job_id, "status": "queued", "source": source, "title": title}


@app.get("/api/v1/jobs/{job_id}")
@limiter.limit("60/minute")
async def get_job_endpoint(request: Request, job_id: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,64}", job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    from app.jobs import get_job

    doc = await get_job(job_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return _doc_to_job_response(doc)


@app.get("/api/v1/results/{job_id}/{filename}")
@limiter.limit("60/minute")
async def get_result(request: Request, job_id: str, filename: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,64}", job_id):
        raise HTTPException(status_code=404, detail="Not found")
    safe_name = Path(filename).name
    if safe_name != filename or not re.fullmatch(r"[a-zA-Z0-9_\-]+\.(mp3|wav)", filename):
        raise HTTPException(status_code=404, detail="Not found")
    # Validate job exists and filename is in results (or check S3 directly)
    from app.jobs import get_job
    from app.storage import is_s3_configured, object_exists, presigned_get_url, result_key

    # If S3 not configured, try to check job doc results and return 404 with helpful message
    doc = await get_job(job_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Job not found")

    # Check if filename is listed in job results (when job is done) — but also allow direct S3 check
    # so partial/legacy jobs still work.
    allowed_filenames: set[str] = set()
    for r in doc.get("results") or []:
        if isinstance(r, dict):
            # url may be /api/v1/results/{job_id}/{filename}
            url = r.get("url") or ""
            key = r.get("key") or r.get("s3_key") or ""
            if url:
                allowed_filenames.add(Path(url).name)
            if key:
                allowed_filenames.add(Path(key).name)
            stem = r.get("stem")
            if stem:
                # common filenames
                allowed_filenames.add(f"{stem}.mp3")
                allowed_filenames.add(f"{stem}.wav")

    # Also consider S3 listing when allowed set is empty
    key = result_key(job_id, filename)
    exists = False
    # Prefer explicit S3 existence check when configured
    if is_s3_configured():
        exists = object_exists(key)
        # If not found and we have an allowed list, allow only if in allowed list (to avoid leaking existence)
        if not exists and filename not in allowed_filenames and allowed_filenames:
            raise HTTPException(status_code=404, detail="Result not found")
        if not exists:
            # Fallback: also check without prefix? No — strict.
            raise HTTPException(status_code=404, detail="Result not found")
        # Generate presigned URL with optional download disposition
        download = request.query_params.get("download")
        disposition = 'attachment; filename="%s"' % filename if download else None
        # When download param set, force attachment via response-content-disposition
        url = presigned_get_url(key, expires_in=900, disposition=disposition)
        if url is None:
            raise HTTPException(status_code=404, detail="Result not found")
        return RedirectResponse(url=url, status_code=302)
    else:
        # S3 not configured (dev fallback) — if job is done and file in allowed list, redirect to local placeholder
        if filename not in allowed_filenames:
            # In dev without S3, we cannot serve files — return 404 with clear message
            raise HTTPException(status_code=404, detail="Result not found (S3 not configured in this environment)")
        # Try presigned anyway (may be None)
        download = request.query_params.get("download")
        disposition = 'attachment; filename="%s"' % filename if download else None
        url = presigned_get_url(key, expires_in=900, disposition=disposition)
        if url:
            return RedirectResponse(url=url, status_code=302)
        raise HTTPException(status_code=404, detail="Result not found (S3 not configured)")


# ---------------------------------------------------------------------------
# Internal dispatcher (Cloud Tasks -> Cloud Run Jobs fallback)
# ---------------------------------------------------------------------------

@app.post("/api/v1/internal/dispatch")
async def internal_dispatch(request: Request):
    """Fallback dispatcher for Cloud Tasks when direct Run API is not used.

    In production this would call run.googleapis.com to trigger the Job.
    In scaffold, it logs and returns 202 so Cloud Tasks considers the task dispatched.
    The actual Job execution is handled by Cloud Run Jobs runner (outside this service).
    """
    token_env = os.environ.get("INTERNAL_DISPATCH_TOKEN", "")
    try:
        token_setting = get_settings().INTERNAL_DISPATCH_TOKEN
    except Exception:
        token_setting = ""
    expected = token_env or token_setting
    is_placeholder = not expected or expected.strip() in ("", "<INTERNAL_DISPATCH_TOKEN>")
    if not is_placeholder:
        provided = request.headers.get("X-Dispatch-Token", "")
        if provided != expected:
            raise HTTPException(status_code=403, detail="Forbidden")
    else:
        logger.warning("INTERNAL_DISPATCH_TOKEN not configured — internal/dispatch auth skipped (dev fallback)")
    try:
        body = await request.json()
    except Exception:
        body = {}
    job_id = body.get("job_id") if isinstance(body, dict) else None
    logger.info("internal/dispatch received for job_id=%s body=%s", job_id, body)
    # In a full implementation, trigger the Job execution here via google-cloud-run client.
    # For now, acknowledge receipt so Cloud Tasks does not retry indefinitely.
    return {"status": "dispatched", "job_id": job_id}


# Root redirect for convenience
@app.get("/")
async def root():
    return {"service": "vocal-remover-api", "docs": "/docs", "health": "/api/v1/health"}
