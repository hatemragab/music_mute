"""End-to-end local tests for Vocal Remover backend.

Tests complete workflow:
1. Audio and video test file generation (via ffmpeg or wave/struct fallback).
2. POST /api/v1/separate with audio file upload -> job queued.
3. POST /api/v1/separate with video file upload (.mp4) -> job queued.
4. Separation worker execution (mocking heavy ONNX separation step) -> job status done.
5. GET /api/v1/jobs/{id} -> status done with results stems.
6. GET /api/v1/results/{id}/{stem}.mp3 -> valid redirect or file retrieval.
7. YouTube URL validation and job queuing flow.
"""

from __future__ import annotations

import io
import math
import os
import shutil
import struct
import subprocess
import tempfile
import wave
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.db import fallback_store


# ---------------------------------------------------------------------------
# Test file generation helpers
# ---------------------------------------------------------------------------


def generate_test_audio_bytes(duration_s: float = 2.0, freq: float = 440.0, sample_rate: int = 44100) -> bytes:
    """Generate a valid WAV audio file in-memory using python wave/struct or ffmpeg."""
    if shutil.which("ffmpeg"):
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            cmd = [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency={freq}:duration={duration_s}",
                "-ar",
                str(sample_rate),
                "-ac",
                "2",
                tmp_path,
            ]
            subprocess.run(cmd, check=True, capture_output=True)
            with open(tmp_path, "rb") as f:
                return f.read()
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    # Fallback via python wave & struct
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        n_samples = int(duration_s * sample_rate)
        for i in range(n_samples):
            val = int(32767.0 * 0.5 * math.sin(2.0 * math.pi * freq * i / sample_rate))
            wav_file.writeframes(struct.pack("<h", val))
    return buf.getvalue()


def generate_test_video_bytes(duration_s: float = 2.0) -> bytes:
    """Generate a test MP4 video with audio stream (via ffmpeg or fallback)."""
    if shutil.which("ffmpeg"):
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            cmd = [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"color=c=black:s=320x240:d={duration_s}",
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency=440:duration={duration_s}",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                "-shortest",
                tmp_path,
            ]
            subprocess.run(cmd, check=True, capture_output=True)
            with open(tmp_path, "rb") as f:
                return f.read()
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    # Fallback minimal MP4 header
    return (
        b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00isommp42"
        b"\x00\x00\x00\x08free"
        b"\x00\x00\x00\x10mdat" + b"\x00" * 64
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def clean_in_memory_store():
    """Reset fallback store before each test."""
    fallback_store().clear()
    yield
    fallback_store().clear()


@pytest.fixture()
def client():
    """TestClient configured with in-memory DB and mocked S3/tasks."""
    with (
        patch("app.db.ensure_indexes", new=AsyncMock(return_value=None)),
        patch("app.db.is_fallback_mode", return_value=True),
        patch("app.jobs.is_fallback_mode", return_value=True),
        patch("app.jobs.check_concurrent_limit", new=AsyncMock(return_value=True)),
        patch("app.jobs.enqueue_task", new=AsyncMock(return_value=None)),
    ):
        from app.main import app

        # Disable slowapi limiter for deterministic tests
        orig_enabled = getattr(app.state.limiter, "enabled", True)
        try:
            app.state.limiter.enabled = False
            app.state.limiter.reset()
        except Exception:
            pass

        try:
            with TestClient(app) as c:
                yield c
        finally:
            try:
                app.state.limiter.enabled = orig_enabled
            except Exception:
                pass


# ---------------------------------------------------------------------------
# End-to-End Tests
# ---------------------------------------------------------------------------


def test_e2e_audio_upload_flow(client: TestClient):
    """E2E Test 1: Upload audio file -> job queued in DB with source=upload."""
    audio_bytes = generate_test_audio_bytes(duration_s=2.0)
    assert len(audio_bytes) > 0

    response = client.post(
        "/api/v1/separate",
        data={"model": "UVR-MDX-NET-Inst_HQ_3", "stems": "2stems"},
        files={"file": ("test_sine.wav", audio_bytes, "audio/wav")},
    )

    assert response.status_code == 202, response.text
    data = response.json()
    assert "job_id" in data
    assert data["status"] == "queued"
    assert data["source"] == "upload"
    assert data["title"] == "test_sine.wav"

    # Query job status via API
    job_id = data["job_id"]
    job_resp = client.get(f"/api/v1/jobs/{job_id}")
    assert job_resp.status_code == 200
    job_data = job_resp.json()
    assert job_data["job_id"] == job_id
    assert job_data["status"] == "queued"
    assert job_data["model"] == "UVR-MDX-NET-Inst_HQ_3"


def test_e2e_video_upload_flow(client: TestClient):
    """E2E Test 2: Upload MP4 video file -> job queued in DB with source=upload."""
    video_bytes = generate_test_video_bytes(duration_s=2.0)
    assert len(video_bytes) > 0

    response = client.post(
        "/api/v1/separate",
        data={"model": "Kim_Vocal_2", "stems": "vocals"},
        files={"file": ("sample_clip.mp4", video_bytes, "video/mp4")},
    )

    assert response.status_code == 202, response.text
    data = response.json()
    assert "job_id" in data
    assert data["status"] == "queued"
    assert data["source"] == "upload"
    assert data["title"] == "sample_clip.mp4"

    # Query job status via API
    job_id = data["job_id"]
    job_resp = client.get(f"/api/v1/jobs/{job_id}")
    assert job_resp.status_code == 200
    job_data = job_resp.json()
    assert job_data["job_id"] == job_id
    assert job_data["status"] == "queued"
    assert job_data["model"] == "Kim_Vocal_2"


def test_e2e_youtube_url_flow(client: TestClient):
    """E2E Test 3: Validate and submit YouTube URL -> job queued."""
    # Invalid YouTube URLs rejected with 400
    invalid_resp = client.post(
        "/api/v1/separate",
        data={"model": "UVR-MDX-NET-Inst_HQ_3", "stems": "2stems", "youtube_url": "https://vimeo.com/123456"},
    )
    assert invalid_resp.status_code == 400
    assert "Invalid youtube_url" in invalid_resp.json()["detail"]

    # Valid YouTube URL accepted
    yt_url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    valid_resp = client.post(
        "/api/v1/separate",
        data={"model": "htdemucs", "stems": "4stems", "youtube_url": yt_url},
    )
    assert valid_resp.status_code == 202, valid_resp.text
    data = valid_resp.json()
    assert "job_id" in data
    assert data["status"] == "queued"
    assert data["source"] == "youtube"

    job_id = data["job_id"]
    job_resp = client.get(f"/api/v1/jobs/{job_id}")
    assert job_resp.status_code == 200
    job_data = job_resp.json()
    assert job_data["job_id"] == job_id
    assert job_data["status"] == "queued"
    assert job_data["model"] == "htdemucs"


@pytest.mark.asyncio
async def test_e2e_worker_execution_and_results_flow(client: TestClient):
    """E2E Test 4: End-to-end pipeline execution from queued job -> worker run -> results retrieval."""
    from app.workers.separation import run_job

    # 1. Post job via API
    audio_bytes = generate_test_audio_bytes(duration_s=2.0)
    post_resp = client.post(
        "/api/v1/separate",
        data={"model": "UVR-MDX-NET-Inst_HQ_3", "stems": "2stems"},
        files={"file": ("full_track.wav", audio_bytes, "audio/wav")},
    )
    assert post_resp.status_code == 202
    job_id = post_resp.json()["job_id"]

    # 2. Run the separation worker directly with mock separator & ffmpeg processing
    with tempfile.TemporaryDirectory() as td:
        input_wav = os.path.join(td, "input.wav")
        with open(input_wav, "wb") as f:
            f.write(audio_bytes)

        # Mock separator output stems
        mock_wrapper = MagicMock()
        stem_vocals = os.path.join(td, "vocals.wav")
        stem_instrumental = os.path.join(td, "instrumental.wav")
        with open(stem_vocals, "wb") as f:
            f.write(audio_bytes)
        with open(stem_instrumental, "wb") as f:
            f.write(audio_bytes)
        mock_wrapper.separate.return_value = [stem_vocals, stem_instrumental]

        # Patch worker dependencies to run fully locally
        with (
            patch("app.workers.separation._download_upload_input", return_value=input_wav),
            patch("app.services.separator.SeparatorWrapper.get", return_value=mock_wrapper),
            patch("app.jobs.is_fallback_mode", return_value=True),
            patch("app.db.is_fallback_mode", return_value=True),
        ):
            await run_job(job_id)

    # 3. Check GET /api/v1/jobs/{job_id} -> status done, progress 100, stems present
    get_resp = client.get(f"/api/v1/jobs/{job_id}")
    assert get_resp.status_code == 200
    job_data = get_resp.json()
    assert job_data["job_id"] == job_id
    assert job_data["status"] == "done"
    assert job_data["progress"] == 100
    assert len(job_data["results"]) >= 2

    stems = {r["stem"]: r["url"] for r in job_data["results"]}
    assert "vocals" in stems
    assert "instrumental" in stems

    # 4. Check GET /api/v1/results/{job_id}/{stem}.mp3
    # In S3-configured environment, it returns 302 redirect to presigned S3 url
    with (
        patch("app.storage.is_s3_configured", return_value=True),
        patch("app.storage.object_exists", return_value=True),
        patch("app.storage.presigned_get_url", return_value="https://s3.example.com/results/vocals.mp3"),
    ):
        result_resp = client.get(f"/api/v1/results/{job_id}/vocals.mp3", follow_redirects=False)
        assert result_resp.status_code == 302
        assert result_resp.headers["location"] == "https://s3.example.com/results/vocals.mp3"

    # Query for nonexistent stem returns 404
    with patch("app.storage.is_s3_configured", return_value=True):
        bad_result = client.get(f"/api/v1/results/{job_id}/nonexistent_stem.mp3")
        assert bad_result.status_code == 404
