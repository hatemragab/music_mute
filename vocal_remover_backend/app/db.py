from __future__ import annotations

import logging
from typing import Any

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorCollection, AsyncIOMotorDatabase

from app.config import get_settings

logger = logging.getLogger(__name__)

_client: AsyncIOMotorClient | None = None
_db: AsyncIOMotorDatabase | None = None

# In-memory fallback when MONGODB_URI is empty/placeholder (local dev without Atlas).
_fallback_store: dict[str, dict[str, Any]] = {}


def _is_placeholder(uri: str) -> bool:
    if not uri or not uri.strip():
        return True
    s = uri.strip()
    return s.startswith("<") or "<" in s or ">" in s or "MONGODB_URI" in s


def is_fallback_mode() -> bool:
    """True when MONGODB_URI is still a placeholder — uses in-memory fallback store."""
    s = get_settings()
    return _is_placeholder(s.MONGODB_URI)


def get_client() -> AsyncIOMotorClient | None:
    global _client
    if is_fallback_mode():
        return None
    if _client is None:
        s = get_settings()
        _client = AsyncIOMotorClient(s.MONGODB_URI)
    return _client


def get_db() -> AsyncIOMotorDatabase | None:
    global _db
    if is_fallback_mode():
        return None
    if _db is None:
        c = get_client()
        assert c is not None
        s = get_settings()
        _db = c[s.MONGODB_DB]
    return _db


def get_jobs_collection() -> AsyncIOMotorCollection | None:
    if is_fallback_mode():
        return None
    db = get_db()
    assert db is not None
    s = get_settings()
    return db[s.MONGODB_COLLECTION]


# Exposed for jobs.py fallback access (tests may monkeypatch).
def fallback_store() -> dict[str, dict[str, Any]]:
    return _fallback_store


async def ensure_indexes() -> None:
    """Create TTL + status indexes. No-op in fallback mode. Best-effort — caller should swallow errors."""
    if is_fallback_mode():
        logger.info("MongoDB fallback mode: skipping ensure_indexes")
        return
    coll = get_jobs_collection()
    assert coll is not None
    s = get_settings()
    # TTL on finishedAt (complements S3 lifecycle); 7 days.
    try:
        await coll.create_index("finishedAt", expireAfterSeconds=s.RESULT_TTL_HOURS * 3600)
    except Exception as e:
        logger.warning("ensure_indexes finishedAt TTL failed: %s", e)
    try:
        await coll.create_index([("status", 1), ("ip", 1)])
    except Exception as e:
        logger.warning("ensure_indexes status/ip failed: %s", e)
    try:
        await coll.create_index("createdAt")
    except Exception as e:
        logger.warning("ensure_indexes createdAt failed: %s", e)


async def ping() -> bool:
    if is_fallback_mode():
        return True
    c = get_client()
    assert c is not None
    await c.admin.command("ping")
    return True
