"""ffmpeg/ffprobe helpers — import-safe, no heavy deps.

Requires ffmpeg and ffprobe on PATH (or in the Cloud Run Job image).
All helpers raise RuntimeError on non-zero exit including stderr excerpt.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path


def _run(cmd: list[str], *, label: str) -> str:
    """Run cmd, return stdout; raise RuntimeError with stderr on failure."""
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        # Trim stderr but keep enough to diagnose.
        stderr = (proc.stderr or "").strip()
        if len(stderr) > 4000:
            stderr = stderr[:4000] + " …[truncated]"
        raise RuntimeError(f"{label} failed (exit {proc.returncode}): {stderr or '(no stderr)'}")
    return proc.stdout


def probe(path: str | Path) -> dict:
    """Probe an audio/video file with ffprobe.

    Returns {"duration_s": float | None, "sample_rate": int | None, "channels": int | None}.
    Picks the first audio stream found; falls back to numerics if missing.
    """
    p = str(path)
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=duration,sample_rate,channels",
        "-of",
        "json",
        p,
    ]
    # ffprobe writes JSON to stdout; warnings/errors to stderr.
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        if len(stderr) > 4000:
            stderr = stderr[:4000] + " …[truncated]"
        raise RuntimeError(f"ffprobe failed (exit {proc.returncode}): {stderr or '(no stderr)'}")

    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"ffprobe produced invalid JSON: {exc}") from exc

    streams = data.get("streams") or []
    # Prefer first audio stream; if none, use first stream.
    chosen = None
    for s in streams:
        # ffprobe stream entries may include codec_type; absent in some builds
        if s.get("codec_type") == "audio":
            chosen = s
            break
    if chosen is None and streams:
        chosen = streams[0]

    def _float(v):
        if v is None:
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    def _int(v):
        if v is None:
            return None
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    if chosen is None:
        return {"duration_s": None, "sample_rate": None, "channels": None}

    return {
        "duration_s": _float(chosen.get("duration")),
        "sample_rate": _int(chosen.get("sample_rate")),
        "channels": _int(chosen.get("channels")),
    }


def convert_to_wav(src: str | Path, dst: str | Path, sr: int = 44100, channels: int = 2) -> str:
    """Convert src audio to wav at sr/channels via ffmpeg. Returns dst path.

    Runs: ffmpeg -y -i src -ar sr -ac channels dst
    """
    s = str(src)
    d = str(dst)
    # Ensure destination parent exists
    Path(d).parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-y", "-i", s, "-ar", str(sr), "-ac", str(channels), d]
    _run(cmd, label="ffmpeg convert_to_wav")
    return d


def encode_mp3(wav_path: str | Path, mp3_path: str | Path, bitrate: str = "192k") -> str:
    """Re-encode a wav to mp3. Returns mp3_path.

    Runs: ffmpeg -y -i wav -b:a bitrate mp3
    """
    w = str(wav_path)
    m = str(mp3_path)
    Path(m).parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-y", "-i", w, "-b:a", bitrate, m]
    _run(cmd, label="ffmpeg encode_mp3")
    return m
