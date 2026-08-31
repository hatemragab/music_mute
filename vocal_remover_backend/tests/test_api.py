"""FastAPI endpoint tests — no real Mongo/S3 required.

All IO-bound deps are mocked:
  - app.db.get_jobs_collection  -> None / AsyncMock (fallback path)
  - app.db.is_fallback_mode     -> True where needed
  - app.storage.get_s3_client   -> None / MagicMock
  - app.storage.is_s3_configured / object_exists / presigned_get_url
  - app.jobs.enqueue_task       -> AsyncMock
  - app.jobs.check_concurrent_limit -> True (not rate limited)

Tests use FastAPI TestClient with lifespan handled safely.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    """TestClient with deps mocked so that startup lifespan does not need real Mongo/S3.

    We patch ensure_indexes and s3/head checks at import time so that the
    TestClient startup path never reaches real IO.
    """
    # Mock everything needed by lifespan + health before app is exercised.
    # Note: main.py imports ensure_indexes lazily inside lifespan, so patch
    # via app.db.ensure_indexes works.
    with (
        patch("app.db.ensure_indexes", new=AsyncMock(return_value=None)),
        patch("app.db.is_fallback_mode", return_value=True),
        patch("app.db.get_jobs_collection", return_value=None),
        patch("app.storage.get_s3_client", return_value=None),
        patch("app.storage.is_s3_configured", return_value=False),
        patch("app.storage.head_bucket_ok", return_value=True),
        patch("app.storage.object_exists", return_value=False),
        patch("app.storage.presigned_get_url", return_value=None),
        patch("app.jobs.check_concurrent_limit", new=AsyncMock(return_value=True)),
        patch("app.jobs.enqueue_task", new=AsyncMock(return_value=None)),
    ):
        # Import app inside patches so that module-level construction sees mocked settings if needed
        from app.main import app  # noqa: WPS433

        # Disable slowapi limiter for deterministic tests (avoid 429 flakiness)
        # Newer slowapi (0.1.10) has no limiter.hit — toggle via app.state.limiter.enabled
        orig_enabled = getattr(app.state.limiter, "enabled", True)
        try:
            app.state.limiter.enabled = False  # type: ignore[attr-defined]
        except Exception:
            pass
        try:
            app.state.limiter.reset()  # type: ignore[attr-defined]
        except Exception:
            pass
        try:
            with TestClient(app) as c:
                yield c
        finally:
            try:
                app.state.limiter.enabled = orig_enabled  # type: ignore[attr-defined]
            except Exception:
                pass


def test_health_returns_ok(client: TestClient):
    """GET /api/v1/health returns 200 and status ok/degraded with expected keys."""
    # health internally calls app.db.ping / head_bucket_ok / tasks client — mock those dynamically
    with (
        patch("app.db.is_fallback_mode", return_value=True),
        patch("app.storage.is_s3_configured", return_value=False),
        patch("app.storage.head_bucket_ok", return_value=True),
    ):
        resp = client.get("/api/v1/health")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "status" in body
    assert "mongo" in body
    assert "s3" in body
    assert "queue" in body
    assert "models_baked" in body
    # With fallback S3 not configured + fallback mongo, status should be degraded (not 500)
    assert body["status"] in ("ok", "degraded")


def test_separate_requires_file_or_url(client: TestClient):
    """POST /separate with neither file nor youtube_url -> 400."""
    with (
        patch("app.db.get_jobs_collection", return_value=None),
        patch("app.storage.get_s3_client", return_value=None),
        patch("app.jobs.check_concurrent_limit", new=AsyncMock(return_value=True)),
    ):
        resp = client.post("/api/v1/separate", data={"model": "UVR-MDX-NET-Inst_HQ_3", "stems": "2stems"})
    assert resp.status_code == 400, resp.text
    assert "file" in resp.json()["detail"].lower() or "youtube" in resp.json()["detail"].lower()


def test_separate_rejects_invalid_model(client: TestClient):
    """POST /separate with invalid model returns 400 error."""
    resp = client.post(
        "/api/v1/separate",
        data={"model": "nonexistent_model", "stems": "2stems", "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
    )
    assert resp.status_code == 400
    assert "Invalid model" in resp.json()["detail"]


def test_separate_rejects_invalid_stems(client: TestClient):
    """POST /separate with invalid stems returns 400 error."""
    resp = client.post(
        "/api/v1/separate",
        data={"model": "UVR-MDX-NET-Inst_HQ_3", "stems": "10stems", "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
    )
    assert resp.status_code == 400
    assert "Invalid stems" in resp.json()["detail"]


def test_separate_rejects_invalid_youtube_url(client: TestClient):
    """POST /separate with invalid youtube_url returns 400 error."""
    resp = client.post(
        "/api/v1/separate",
        data={"model": "UVR-MDX-NET-Inst_HQ_3", "stems": "2stems", "youtube_url": "https://notyoutube.com/video"},
    )
    assert resp.status_code == 400
    assert "Invalid youtube_url" in resp.json()["detail"]


def test_separate_valid_youtube_creates_job(client: TestClient):
    """POST /separate with valid youtube_url creates queued job and returns 202."""
    with (
        patch("app.jobs.create_job_doc", new=AsyncMock(return_value={})),
        patch("app.jobs.enqueue_task", new=AsyncMock(return_value=None)),
        patch("app.jobs.check_concurrent_limit", new=AsyncMock(return_value=True)),
    ):
        resp = client.post(
            "/api/v1/separate",
            data={"model": "UVR-MDX-NET-Inst_HQ_3", "stems": "2stems", "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
        )
    assert resp.status_code == 202
    body = resp.json()
    assert "job_id" in body
    assert body["status"] == "queued"
    assert body["source"] == "youtube"


def test_separate_valid_file_creates_job(client: TestClient):
    """POST /separate with valid audio file creates queued job and returns 202."""
    fake_audio = b"ID3\x03\x00\x00\x00\x00\x00#TSSE\x00\x00\x00\x0f\x00\x00\x03Lavf58.76.100\x00" + b"\x00" * 200
    with (
        patch("app.jobs.create_job_doc", new=AsyncMock(return_value={})),
        patch("app.jobs.enqueue_task", new=AsyncMock(return_value=None)),
        patch("app.jobs.check_concurrent_limit", new=AsyncMock(return_value=True)),
    ):
        resp = client.post(
            "/api/v1/separate",
            data={"model": "Kim_Vocal_2", "stems": "vocals"},
            files={"file": ("song.mp3", fake_audio, "audio/mpeg")},
        )
    assert resp.status_code == 202
    body = resp.json()
    assert "job_id" in body
    assert body["status"] == "queued"
    assert body["source"] == "upload"
    assert body["title"] == "song.mp3"


def test_separate_rejects_invalid_file_type(client: TestClient):
    """POST /separate with non-audio file extension or text content returns 400."""
    with (
        patch("app.main._magic_ok", return_value=False),
        patch("app.jobs.check_concurrent_limit", new=AsyncMock(return_value=True)),
    ):
        resp = client.post(
            "/api/v1/separate",
            data={"model": "UVR-MDX-NET-Inst_HQ_3", "stems": "2stems"},
            files={"file": ("bad_script.py", b"print('not audio')", "text/plain")},
        )
    assert resp.status_code == 400
    assert "File type not allowed" in resp.json()["detail"]


def test_separate_concurrent_limit_exceeded(client: TestClient):
    """POST /separate when client IP is over concurrent limit returns 429."""
    with patch("app.jobs.check_concurrent_limit", new=AsyncMock(return_value=False)):
        resp = client.post(
            "/api/v1/separate",
            data={"model": "UVR-MDX-NET-Inst_HQ_3", "stems": "2stems", "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
        )
    assert resp.status_code == 429
    assert "Too many concurrent jobs" in resp.json()["detail"]


def test_get_models_payload_structure(client: TestClient):
    """GET /models returns list matching ModelInfo schema with exact field names and types."""
    resp = client.get("/api/v1/models")
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    assert len(body) >= 3
    for model in body:
        assert isinstance(model["name"], str)
        assert isinstance(model["display_name"], str)
        assert isinstance(model["stems_supported"], list)
        assert len(model["stems_supported"]) > 0
        assert isinstance(model["est_speed"], str)
        assert isinstance(model["est_ram"], str)
        assert isinstance(model["description"], str)


def test_get_job_success_payload_structure(client: TestClient):
    """GET /jobs/{id} returns full job details matching JobResponse structure."""
    fake_doc = {
        "_id": "job999",
        "job_id": "job999",
        "status": "processing",
        "progress": 45,
        "stage": "separating",
        "model": "UVR-MDX-NET-Inst_HQ_3",
        "stems": ["vocals", "instrumental"],
        "results": [],
        "error": None,
        "createdAt": "2026-08-31T12:00:00Z",
        "finishedAt": None,
    }
    with patch("app.jobs.get_job", new=AsyncMock(return_value=fake_doc)):
        resp = client.get("/api/v1/jobs/job999")
    assert resp.status_code == 200
    data = resp.json()
    assert data["job_id"] == "job999"
    assert data["status"] == "processing"
    assert data["progress"] == 45
    assert data["stage"] == "separating"
    assert data["model"] == "UVR-MDX-NET-Inst_HQ_3"
    assert data["stems"] == ["vocals", "instrumental"]
    assert data["results"] == []


def test_results_path_traversal_rejected(client: TestClient):
    """GET /results/{job_id}/{filename} with path traversal attempt returns 404."""
    resp = client.get("/api/v1/results/job123/../../etc/passwd")
    assert resp.status_code == 404


def test_results_presigned_download_disposition(client: TestClient):
    """GET /results/{job_id}/{filename}?download=true includes attachment disposition in presigned url call."""
    job_id = "testjob123"
    filename = "vocals.mp3"
    fake_doc = {
        "job_id": job_id,
        "status": "done",
        "results": [{"stem": "vocals", "key": f"results/{job_id}/vocals.mp3"}],
    }
    with (
        patch("app.jobs.get_job", new=AsyncMock(return_value=fake_doc)),
        patch("app.storage.is_s3_configured", return_value=True),
        patch("app.storage.object_exists", return_value=True),
        patch("app.storage.presigned_get_url") as mock_presigned,
    ):
        mock_presigned.return_value = "https://s3.example.com/download/vocals.mp3"
        resp = client.get(f"/api/v1/results/{job_id}/{filename}?download=1", follow_redirects=False)
        assert resp.status_code == 302
        assert resp.headers["location"] == "https://s3.example.com/download/vocals.mp3"
        mock_presigned.assert_called_once_with(
            f"results/{job_id}/{filename}",
            expires_in=900,
            disposition='attachment; filename="vocals.mp3"',
        )


def test_internal_dispatch_endpoint(client: TestClient):
    """POST /api/v1/internal/dispatch acknowledges receipt with 200."""
    resp = client.post("/api/v1/internal/dispatch", json={"job_id": "job123"})
    assert resp.status_code == 200
    assert resp.json() == {"status": "dispatched", "job_id": "job123"}


def test_root_endpoint(client: TestClient):
    """GET / returns service metadata."""
    resp = client.get("/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["service"] == "vocal-remover-api"
    assert "docs" in body
    assert "health" in body


def test_separate_rejects_both_file_and_url(client: TestClient):
    """POST /separate with both file and youtube_url -> 400."""
    with (
        patch("app.db.get_jobs_collection", return_value=None),
        patch("app.storage.get_s3_client", return_value=None),
        patch("app.jobs.check_concurrent_limit", new=AsyncMock(return_value=True)),
    ):
        resp = client.post(
            "/api/v1/separate",
            data={"youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "model": "UVR-MDX-NET-Inst_HQ_3"},
            files={"file": ("test.mp3", b"fake audio bytes here for test", "audio/mpeg")},
        )
    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"].lower()
    assert "both" in detail or "exactly one" in detail


def test_get_job_not_found(client: TestClient):
    """GET /jobs/{unknown} -> 404."""
    unknown = "doesnotexist12"
    with patch("app.jobs.get_job", new=AsyncMock(return_value=None)):
        resp = client.get(f"/api/v1/jobs/{unknown}")
    assert resp.status_code == 404, resp.text
    assert "not found" in resp.json()["detail"].lower()


def test_get_models_lists_three_models(client: TestClient):
    """GET /models lists exactly the three configured models."""
    resp = client.get("/api/v1/models")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert isinstance(body, list)
    names = {m["name"] for m in body}
    assert names == {"UVR-MDX-NET-Inst_HQ_3", "Kim_Vocal_2", "htdemucs"}
    # Each entry has expected keys
    for m in body:
        assert "name" in m
        assert "stems_supported" in m
        assert "est_ram" in m


def test_results_redirect_302_or_404(client: TestClient):
    """GET /results/{job}/{file} -> 302 to S3 presigned URL when present, else 404.

    This is a single test per spec name (302_or_404): happy path yields 302,
    missing result yields 404. Both assertions live here so we satisfy the spec
    without splitting into two tests.
    """
    job_id = "abc123result"
    filename = "vocals.mp3"

    # --- Case A: object exists -> expect 302 redirect ---
    fake_doc = {
        "job_id": job_id,
        "_id": job_id,
        "status": "done",
        "progress": 100,
        "stage": "done",
        "model": "UVR-MDX-NET-Inst_HQ_3",
        "stems": ["vocals", "instrumental"],
        "results": [
            {"stem": "vocals", "key": f"results/{job_id}/vocals.mp3", "size_bytes": 12345, "duration_s": 10.0},
            {"stem": "instrumental", "key": f"results/{job_id}/instrumental.mp3", "size_bytes": 12345, "duration_s": 10.0},
        ],
        "created_at": None,
        "finished_at": None,
    }
    with (
        patch("app.jobs.get_job", new=AsyncMock(return_value=fake_doc)),
        patch("app.storage.is_s3_configured", return_value=True),
        patch("app.storage.object_exists", return_value=True),
        patch("app.storage.presigned_get_url", return_value="https://s3.example.com/presigned/vocals.mp3?sig=abc"),
    ):
        resp = client.get(f"/api/v1/results/{job_id}/{filename}", follow_redirects=False)
    assert resp.status_code == 302, resp.text
    loc = resp.headers.get("location", "")
    assert "s3.example.com" in loc or "presigned" in loc or "https://" in loc

    # --- Case B: result not found -> 404 ---
    missing_doc = {**fake_doc, "results": [{"stem": "vocals", "key": f"results/{job_id}/vocals.mp3"}]}
    with (
        patch("app.jobs.get_job", new=AsyncMock(return_value=missing_doc)),
        patch("app.storage.is_s3_configured", return_value=True),
        patch("app.storage.object_exists", return_value=False),
        patch("app.storage.presigned_get_url", return_value=None),
    ):
        resp2 = client.get(f"/api/v1/results/{job_id}/nonexistent.mp3", follow_redirects=False)
    assert resp2.status_code == 404, resp2.text
