"""Tests for job operations and helpers (MongoDB & fallback, concurrency, validation)."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from app.db import fallback_store
from app.jobs import (
    check_concurrent_limit,
    create_job_doc,
    enqueue_task,
    get_job,
    update_job,
)


@pytest.fixture(autouse=True)
def clean_fallback_store():
    """Ensure in-memory fallback store is clean before/after tests."""
    fallback_store().clear()
    yield
    fallback_store().clear()


@pytest.mark.asyncio
async def test_create_and_get_job_fallback():
    """Test job doc creation and retrieval in in-memory fallback mode."""
    with patch("app.jobs.is_fallback_mode", return_value=True):
        doc = await create_job_doc(
            job_id="job123",
            ip="127.0.0.1",
            model="UVR-MDX-NET-Inst_HQ_3",
            stems="2stems",
            source="upload",
            title="test.mp3",
        )
        assert doc["job_id"] == "job123"
        assert doc["status"] == "queued"
        assert doc["progress"] == 0

        fetched = await get_job("job123")
        assert fetched is not None
        assert fetched["_id"] == "job123"
        assert fetched["title"] == "test.mp3"


@pytest.mark.asyncio
async def test_update_job_fallback():
    """Test updating fields in fallback store (e.g. progress, finished_at, status)."""
    with patch("app.jobs.is_fallback_mode", return_value=True):
        await create_job_doc(
            job_id="job456",
            ip="127.0.0.1",
            model="Kim_Vocal_2",
            stems="vocals",
            source="youtube",
            title="song",
        )

        now = datetime.now(timezone.utc)
        ok = await update_job("job456", {"status": "done", "progress": 100, "finished_at": now})
        assert ok is True

        job = await get_job("job456")
        assert job is not None
        assert job["status"] == "done"
        assert job["progress"] == 100
        assert job["finished_at"] == now
        assert job["finishedAt"] == now
        assert "updatedAt" in job


@pytest.mark.asyncio
async def test_update_job_nonexistent():
    """Updating nonexistent job in fallback returns False."""
    with patch("app.jobs.is_fallback_mode", return_value=True):
        ok = await update_job("nonexistent", {"progress": 50})
        assert ok is False


@pytest.mark.asyncio
async def test_check_concurrent_limit_fallback():
    """Test IP concurrent job limit evaluation in fallback mode."""
    with patch("app.jobs.is_fallback_mode", return_value=True):
        ip = "192.168.1.100"
        assert await check_concurrent_limit(ip, limit=2) is True

        # Add 1 active job
        await create_job_doc("j1", ip=ip, model="htdemucs", stems="4stems", source="upload", title="1.mp3")
        assert await check_concurrent_limit(ip, limit=2) is True

        # Add 2nd active job
        await create_job_doc("j2", ip=ip, model="htdemucs", stems="4stems", source="upload", title="2.mp3")
        # Now at limit (2 active)
        assert await check_concurrent_limit(ip, limit=2) is False

        # Mark one job as done
        await update_job("j1", {"status": "done"})
        # Now 1 active job -> under limit again
        assert await check_concurrent_limit(ip, limit=2) is True


@pytest.mark.asyncio
async def test_enqueue_task_graceful_missing_gcp():
    """enqueue_task logs a warning and completes without exception when GCP is unconfigured."""
    with (
        patch("app.jobs.get_settings") as mock_settings,
    ):
        settings_instance = MagicMock()
        settings_instance.GCP_PROJECT_ID = "<GCP_PROJECT_ID>"
        settings_instance.BASE_URL = "<CLOUD_RUN_URL>"
        settings_instance.TASK_QUEUE = "vocal-jobs"
        mock_settings.return_value = settings_instance

        # Should not raise exception
        await enqueue_task("job-test", "UVR-MDX-NET-Inst_HQ_3", "2stems")
