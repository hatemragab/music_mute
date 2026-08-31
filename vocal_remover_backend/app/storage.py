from __future__ import annotations

import logging
import os
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from app.config import get_settings

logger = logging.getLogger(__name__)

_client: Any | None = None


def _is_placeholder(v: str) -> bool:
    """Placeholder if empty, or contains any `<...>` token (covers embedded placeholders like Secret Manager path)."""
    if not v or not v.strip():
        return True
    s = v.strip()
    return s.startswith("<") or "<" in s or ">" in s


def is_s3_configured() -> bool:
    s = get_settings()
    return not _is_placeholder(s.S3_BUCKET) and not _is_placeholder(s.AWS_REGION)


def get_s3_client() -> Any | None:
    global _client
    if not is_s3_configured():
        return None
    if _client is not None:
        return _client
    s = get_settings()
    kwargs: dict[str, Any] = {"region_name": s.AWS_REGION}
    # Only pass explicit creds if they look real; otherwise rely on env/IAM role.
    if not _is_placeholder(s.AWS_ACCESS_KEY_ID) and not _is_placeholder(s.AWS_SECRET_ACCESS_KEY):
        kwargs["aws_access_key_id"] = s.AWS_ACCESS_KEY_ID
        kwargs["aws_secret_access_key"] = s.AWS_SECRET_ACCESS_KEY
    try:
        _client = boto3.client("s3", **kwargs)
    except Exception as e:
        logger.warning("boto3 client init failed: %s", e)
        return None
    return _client


def s3_bucket() -> str:
    return get_settings().S3_BUCKET


def upload_key(job_id: str, filename: str) -> str:
    return f"uploads/{job_id}/{filename}"


def result_key(job_id: str, filename: str) -> str:
    return f"results/{job_id}/{filename}"


def presigned_get_url(key: str, expires_in: int = 900, disposition: str | None = None) -> str | None:
    """Generate S3 presigned GET URL. Returns None if S3 not configured."""
    c = get_s3_client()
    if c is None:
        return None
    params: dict[str, Any] = {"Bucket": s3_bucket(), "Key": key}
    if disposition:
        params["ResponseContentDisposition"] = disposition
    try:
        return c.generate_presigned_url("get_object", Params=params, ExpiresIn=expires_in)
    except (BotoCoreError, ClientError) as e:
        logger.warning("presigned_get_url failed for %s: %s", key, e)
        return None


def head_bucket_ok() -> bool:
    """Check S3 bucket reachable. Returns True in unconfigured mode (health shows degraded, not hard fail)."""
    c = get_s3_client()
    if c is None:
        return True  # unconfigured — health will report degraded via is_s3_configured
    try:
        c.head_bucket(Bucket=s3_bucket())
        return True
    except (BotoCoreError, ClientError) as e:
        logger.warning("head_bucket failed: %s", e)
        return False


def object_exists(key: str) -> bool:
    c = get_s3_client()
    if c is None:
        return False
    try:
        c.head_object(Bucket=s3_bucket(), Key=key)
        return True
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
            return False
        logger.warning("head_object %s failed: %s", key, e)
        return False
    except BotoCoreError as e:
        logger.warning("head_object %s failed: %s", key, e)
        return False


def list_result_keys(job_id: str) -> list[str]:
    c = get_s3_client()
    if c is None:
        return []
    prefix = f"results/{job_id}/"
    try:
        resp = c.list_objects_v2(Bucket=s3_bucket(), Prefix=prefix)
        return [o["Key"] for o in resp.get("Contents", [])]
    except (BotoCoreError, ClientError) as e:
        logger.warning("list_objects %s failed: %s", prefix, e)
        return []
