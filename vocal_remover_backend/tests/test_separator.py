"""Unit tests for services: ffmpeg, youtube, separator.

All tests are isolated — no real ffprobe / yt-dlp / model downloads needed.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# ffmpeg
# ---------------------------------------------------------------------------


def test_ffmpeg_probe_missing_file_raises():
    """probe() on a non-existent / invalid file raises RuntimeError (via ffprobe failure)."""
    from app.services.ffmpeg import probe

    # File does not exist -> ffprobe exits non-zero -> probe should raise RuntimeError.
    # We mock subprocess.run so the test does not require ffprobe on PATH.
    fake_failed = MagicMock()
    fake_failed.returncode = 1
    fake_failed.stdout = ""
    fake_failed.stderr = "ffprobe: No such file or directory"

    with patch("app.services.ffmpeg.subprocess.run", return_value=fake_failed):
        with pytest.raises(RuntimeError, match="ffprobe failed"):
            probe("/tmp/does_not_exist_12345_xyz.wav")

    # Also verify that a real missing file (without mock) still raises when ffprobe *is* absent:
    # if ffprobe is not installed, probe raises RuntimeError or FileNotFoundError — both acceptable.
    # We assert via the mock path only so CI remains deterministic.


# ---------------------------------------------------------------------------
# youtube
# ---------------------------------------------------------------------------


def test_youtube_validate_url():
    """validate_youtube_url accepts known forms and rejects others."""
    from app.services.youtube import validate_youtube_url

    good = [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtube.com/watch?v=dQw4w9WgXcQ&t=10s",
        "https://youtu.be/dQw4w9WgXcQ",
        "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    ]
    bad = [
        "",
        "not a url",
        "https://example.com/watch?v=dQw4w9WgXcQ",
        "https://vimeo.com/123456",
        "ftp://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/",
    ]
    for u in good:
        assert validate_youtube_url(u) is True, f"expected True for {u!r}"
    for u in bad:
        assert validate_youtube_url(u) is False, f"expected False for {u!r}"


# ---------------------------------------------------------------------------
# separator
# ---------------------------------------------------------------------------


def test_separator_model_map_contains_expected_keys():
    """MODEL_MAP contains the three expected models and no extras that would break the API."""
    from app.services.separator import MODEL_MAP

    expected = {"UVR-MDX-NET-Inst_HQ_3", "Kim_Vocal_2", "htdemucs"}
    assert set(MODEL_MAP.keys()) == expected, f"MODEL_MAP keys {set(MODEL_MAP.keys())!r} != {expected!r}"
    # Values are non-empty strings
    for k, v in MODEL_MAP.items():
        assert isinstance(v, str) and v.strip() != "", f"MODEL_MAP[{k!r}] should be a non-empty string"
    # ALLOWED_MODELS parity (main.py keeps its own tuple, but MODEL_MAP is the worker's source of truth)
    assert "UVR-MDX-NET-Inst_HQ_3" in MODEL_MAP
    assert "Kim_Vocal_2" in MODEL_MAP
    assert "htdemucs" in MODEL_MAP


def test_ffmpeg_convert_to_wav_command_execution():
    """convert_to_wav constructs proper ffmpeg arguments and invokes subprocess."""
    from app.services.ffmpeg import convert_to_wav

    fake_res = MagicMock()
    fake_res.returncode = 0
    fake_res.stdout = "ok"
    fake_res.stderr = ""

    with patch("app.services.ffmpeg.subprocess.run", return_value=fake_res) as mock_run:
        dst = convert_to_wav("/tmp/test_in.mp3", "/tmp/test_out.wav", sr=44100, channels=2)
        assert dst == "/tmp/test_out.wav"
        mock_run.assert_called_once()
        cmd = mock_run.call_args[0][0]
        assert cmd[:4] == ["ffmpeg", "-y", "-i", "/tmp/test_in.mp3"]
        assert "-ar" in cmd and "44100" in cmd
        assert "-ac" in cmd and "2" in cmd


def test_ffmpeg_encode_mp3_command_execution():
    """encode_mp3 constructs proper ffmpeg arguments and invokes subprocess."""
    from app.services.ffmpeg import encode_mp3

    fake_res = MagicMock()
    fake_res.returncode = 0
    fake_res.stdout = "ok"
    fake_res.stderr = ""

    with patch("app.services.ffmpeg.subprocess.run", return_value=fake_res) as mock_run:
        dst = encode_mp3("/tmp/stem.wav", "/tmp/stem.mp3", bitrate="192k")
        assert dst == "/tmp/stem.mp3"
        mock_run.assert_called_once()
        cmd = mock_run.call_args[0][0]
        assert cmd[:4] == ["ffmpeg", "-y", "-i", "/tmp/stem.wav"]
        assert "-b:a" in cmd and "192k" in cmd


def test_ffmpeg_command_error_raising():
    """subprocess non-zero exit in _run raises RuntimeError with stderr."""
    from app.services.ffmpeg import encode_mp3

    fake_res = MagicMock()
    fake_res.returncode = 1
    fake_res.stdout = ""
    fake_res.stderr = "Invalid audio stream"

    with patch("app.services.ffmpeg.subprocess.run", return_value=fake_res):
        with pytest.raises(RuntimeError, match="ffmpeg encode_mp3 failed"):
            encode_mp3("/tmp/broken.wav", "/tmp/broken.mp3")

