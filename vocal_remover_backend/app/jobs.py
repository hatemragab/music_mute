from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from app.config import get_settings
from app.db import fallback_store, get_jobs_collection, is_fallback_mode

logger = logging.getLogger(__name__)

# Limit per IP for queued + processing jobs
CONCURRENT_LIMIT = 2


# ---------------------------------------------------------------------------
# MongoDB helpers (with in-memory fallback for local dev)
# ---------------------------------------------------------------------------

async def create_job_doc(
    job_id: str,
    ip: str,
    model: str,
    stems: str,
    source: str,
    title: str | None,
) -> dict:
    now = datetime.now(timezone.utc)
    doc = {
        "_id": job_id,
        "job_id": job_id,
        "ip": ip,
        "model": model,
        "stems": stems,
        "source": source,
        "title": title,
        "status": "queued",
        "progress": 0,
        "stage": "queued",
        "results": [],
        "error": None,
        "createdAt": now,
        "created_at": now,
        "updatedAt": now,
        "finishedAt": None,
        "finished_at": None,
    }
    if is_fallback_mode():
        fallback_store()[job_id] = doc
        logger.info("create_job_doc (fallback) %s ip=%s source=%s", job_id, ip, source)
        return doc

    coll = get_jobs_collection()
    assert coll is not None
    await coll.insert_one(doc)
    logger.info("create_job_doc %s ip=%s source=%s", job_id, ip, source)
    return doc


async def get_job(job_id: str) -> dict | None:
    if is_fallback_mode():
        return fallback_store().get(job_id)
    coll = get_jobs_collection()
    assert coll is not None
    doc = await coll.find_one({"_id": job_id})
    if doc is None:
        # also try job_id field for legacy docs
        doc = await coll.find_one({"job_id": job_id})
    return doc


async def update_job(job_id: str, fields: dict) -> bool:
    # Always stamp updatedAt
    fields = {**fields, "updatedAt": datetime.now(timezone.utc)}
    # Mirror camelCase / snake_case for finishedAt
    if "finishedAt" in fields and "finished_at" not in fields:
        fields["finished_at"] = fields["finishedAt"]
    if "finished_at" in fields and "finishedAt" not in fields:
        fields["finishedAt"] = fields["finished_at"]

    if is_fallback_mode():
        store = fallback_store()
        doc = store.get(job_id)
        if doc is None:
            return False
        doc.update(fields)
        return True

    coll = get_jobs_collection()
    assert coll is not None
    res = await coll.update_one({"_id": job_id}, {"$set": fields})
    if res.matched_count == 0:
        res = await coll.update_one({"job_id": job_id}, {"$set": fields})
    return res.matched_count > 0


async def check_concurrent_limit(ip: str, limit: int = CONCURRENT_LIMIT) -> bool:
    """Return True if ip is under the concurrent limit, False if at/over limit.

    NOTE Race: this does count_documents then (separately) insert_one in the
    caller (app/main.py:separate -> create_job_doc). Two Cloud Run instances
    can both read count < limit before either inserts, so 3+ concurrent jobs
    can slip through. This is intentionally best-effort. The primary per-IP
    gate is slowapi's rate limiter (see app/main.py:limiter with
    get_remote_address), which is evaluated inline per request. A strict cap
    would require a MongoDB transaction / findOneAndUpdate with a counter
    document or a unique partial index trick, which is not worth the
    complexity for a best-effort 2-concurrent limit in v1. Callers should
    treat a False here as best-effort and log a warning rather than crash
    if the check itself fails (see caller).
    """
    if is_fallback_mode():
        count = sum(
            1
            for d in fallback_store().values()
            if d.get("ip") == ip and d.get("status") in ("queued", "processing")
        )
        return count < limit

    coll = get_jobs_collection()
    assert coll is not None
    count = await coll.count_documents({"ip": ip, "status": {"$in": ["queued", "processing"]}})
    return count < limit


# ---------------------------------------------------------------------------
# Cloud Tasks enqueue
# ---------------------------------------------------------------------------

def _is_placeholder(v: str) -> bool:
    if not v or not v.strip():
        return True
    s = v.strip()
    return s.startswith("<") or "<" in s or ">" in s or "MONGODB_URI" in s or "GCP_PROJECT" in s


async def enqueue_task(job_id: str, model: str, stems: str) -> None:
    """Enqueue a Cloud Tasks HTTP task to trigger the worker.

    Best-effort: logs warning and returns gracefully when GCP credentials
    or config are missing (local dev without Cloud Tasks).
    """
    settings = get_settings()
    project = settings.GCP_PROJECT_ID
    region = settings.GCP_REGION or settings.TASK_QUEUE_LOCATION or "us-central1"
    queue = settings.TASK_QUEUE or "vocal-jobs"
    base_url = settings.BASE_URL

    # If project is placeholder and no base_url, we cannot enqueue — dev fallback.
    if _is_placeholder(project) and _is_placeholder(base_url):
        logger.warning(
            "enqueue_task skipped for %s: GCP credentials missing (GCP_PROJECT_ID placeholder and BASE_URL placeholder). "
            "Job will stay queued until a worker polls.",
            job_id,
        )
        return

    # Prefer Cloud Run Jobs Run API URL when project is configured; otherwise use dispatcher fallback.
    if not _is_placeholder(project):
        target_url = (
            f"https://run.googleapis.com/v1/projects/{project}/locations/{region}/jobs/vocal-remover-worker:run"
        )
        # When using Run API, the task body must include overrides containerOverrides etc.
        # For scaffolding we send a simple JSON and let the dispatcher/worker handle it.
        # If the direct Run API is not desired, fallback to BASE_URL dispatcher is also valid.
        # Choose dispatcher when BASE_URL is real, because Run API requires IAM + different payload shape.
        if not _is_placeholder(base_url) and base_url.startswith("http"):
            # Prefer dispatcher endpoint when BASE_URL is configured (simpler HTTP target).
            target_url = base_url.rstrip("/") + "/api/v1/internal/dispatch"
            logger.info("enqueue_task using dispatcher fallback %s for %s", target_url, job_id)
    else:
        target_url = base_url.rstrip("/") + "/api/v1/internal/dispatch"
        logger.info("enqueue_task using dispatcher fallback %s for %s", target_url, job_id)

    # Try to create Cloud Tasks task
    try:
        from google.cloud import tasks_v2  # type: ignore
        from google.api_core.exceptions import AlreadyExists, NotFound  # type: ignore
    except ImportError as e:
        logger.warning("google-cloud-tasks not installed, enqueue_task skipped for %s: %s", job_id, e)
        return

    try:
        client = tasks_v2.CloudTasksClient()
        parent = client.queue_path(project if not _is_placeholder(project) else "placeholder", region, queue)

        # Ensure queue exists (best-effort)
        try:
            client.get_queue(name=parent)
        except NotFound:
            try:
                # Create queue if missing (requires valid project)
                if not _is_placeholder(project):
                    q_parent = client.location_path(project, region)
                    client.create_queue(
                        parent=q_parent,
                        queue={
                            "name": parent,
                            "rate_limits": {"max_dispatches_per_second": 10, "max_concurrent_dispatches": 10},
                            "retry_config": {"max_attempts": 3},
                        },
                    )
                    logger.info("Created Cloud Tasks queue %s", parent)
            except Exception as qe:
                logger.warning("Could not ensure queue %s exists: %s", parent, qe)
        except Exception as e:
            # get_queue failed for other reasons (e.g., no creds) — log and continue to try create_task
            logger.warning("get_queue check failed for %s: %s", parent, e)

        payload = json.dumps({"job_id": job_id, "model": model, "stems": stems}).encode()
        task = {
            "http_request": {
                "http_method": tasks_v2.HttpMethod.POST,
                "url": target_url,
                "headers": {"Content-Type": "application/json"},
                "body": payload,
            }
        }
        # Optional: OIDC token if service account is configured — skipped in scaffold; Cloud Tasks will
        # need IAM to invoke Run API in production.
        try:
            created = client.create_task(parent=parent, task=task)
            logger.info("Enqueued Cloud Tasks task %s for job %s -> %s", created.name, job_id, target_url)
        except AlreadyExists:
            logger.warning("Task already exists for job %s", job_id)
        except Exception as e:
            logger.warning("create_task failed for job %s: %s (target %s)", job_id, e, target_url)
            # Do not raise — job doc already exists; worker can be triggered manually / via polling fallback.
            # In dev without GCP creds this is expected.
    except Exception as e:
        logger.warning("enqueue_task failed for %s: %s", job_id, e)


# Alias expected by main.py description ("enqueue via jobs.enqueue_job")
enqueue_job = enqueue_task
