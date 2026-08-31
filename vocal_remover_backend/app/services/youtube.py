"""yt-dlp wrapper — import-safe.

Heavy dep yt_dlp is imported lazily inside functions so the module remains
importable without it (tests / Cloud Build stages that don't need it). Same for
Secret Manager / GCP deps.
"""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Any

# 20 min / 50 MB caps per PLAN.md sec 4 & 6. Keep in sync with config/env.
MAX_DURATION_S = 1200
MAX_FILESIZE_BYTES = 50 * 1024 * 1024  # 50 MB

# Matches: youtube.com/watch?v=..., youtu.be/..., youtube.com/shorts/...,
# m.youtube.com, www.youtube.com with extra query params.
_YT_RE = re.compile(
    r"""^https?://              # http/https
        (?:www\.|m\.)?          # optional www. or m.
        (?:                     # host + path alternatives
            youtube\.com/watch\?[^#\s]*v=[A-Za-z0-9_-]{6,}
          | youtube\.com/shorts/[A-Za-z0-9_-]{6,}
          | youtu\.be/[A-Za-z0-9_-]{6,}
        )
    """,
    re.IGNORECASE | re.VERBOSE,
)


def validate_youtube_url(url: str) -> bool:
    """Return True iff url looks like a YouTube watch / youtu.be / shorts URL."""
    if not isinstance(url, str):
        return False
    s = url.strip()
    if not s:
        return False
    return bool(_YT_RE.search(s))


def _resolve_cookies_file(cookies_secret: str | None) -> str | None:
    """Resolve a yt-dlp --cookies file path.

    Priority:
      1. cookies_secret argument if it looks like a filesystem path that exists
      2. env YT_COOKIES_FILE (local dev fallback) if that file exists
      3. env YT_COOKIES_SECRET — if it looks like a filesystem path and exists,
         treat it as a cookies file (some deploys store the path there).
      4. Otherwise None. Real Secret Manager fetch (GCP) is left to the caller
         or to download_audio/preflight which will attempt to pull the secret
         body and write it to a temp file when YT_COOKIES_SECRET looks like a
         GCP resource name (projects/.../secrets/...).

    This helper only deals with filesystem paths; GCP fetch is handled lazily
    in _maybe_fetch_secret_to_tempfile so that google-cloud-secret-manager is
    not a hard import.
    """
    candidates: list[str | None] = []
    if cookies_secret and not str(cookies_secret).startswith("projects/"):
        candidates.append(str(cookies_secret))
    env_file = os.environ.get("YT_COOKIES_FILE")
    if env_file:
        candidates.append(env_file)
    env_secret = os.environ.get("YT_COOKIES_SECRET")
    if env_secret and not str(env_secret).startswith("projects/"):
        candidates.append(env_secret)
    for c in candidates:
        if c and Path(c).is_file():
            return c
    return None


def _maybe_fetch_secret_to_tempfile(secret_name: str | None) -> str | None:
    """If secret_name looks like a GCP Secret Manager resource, fetch it.

    Returns a temp file path containing the secret payload (Netscape cookies txt),
    or None if not applicable / fetch failed. Caller is responsible for unlinking
    the temp file when done. Guarded so google-cloud-secret-manager is optional.
    """
    if not secret_name or not str(secret_name).startswith("projects/"):
        return None
    # Also check env when argument is None
    target = secret_name or os.environ.get("YT_COOKIES_SECRET")
    if not target or not str(target).startswith("projects/"):
        return None
    try:
        # Import lazily — not installed in local dev by default.
        from google.cloud import secretmanager  # type: ignore

        client = secretmanager.SecretManagerServiceClient()
        resp = client.access_secret_version(name=str(target))
        payload = resp.payload.data  # bytes
        if not payload:
            return None
        fd, tmp = tempfile.mkstemp(prefix="yt-cookies-", suffix=".txt")
        os.write(fd, payload)
        os.close(fd)
        return tmp
    except Exception:
        # Secret Manager not configured, no credentials, or library missing — best effort.
        return None


def _ydl_opts_for_cookies(cookies_secret: str | None) -> tuple[dict[str, Any], str | None]:
    """Build yt-dlp cookie options and return (opts, temp_path_to_cleanup)."""
    # 1) filesystem path
    cookiefile = _resolve_cookies_file(cookies_secret)
    if cookiefile:
        return ({"cookiefile": cookiefile}, None)
    # 2) GCP secret -> temp file
    secret_ref = cookies_secret or os.environ.get("YT_COOKIES_SECRET")
    tmp = _maybe_fetch_secret_to_tempfile(secret_ref)
    if tmp:
        return ({"cookiefile": tmp}, tmp)
    return ({}, None)


def preflight(url: str, cookies_secret: str | None = None) -> dict:
    """Fetch metadata with yt-dlp --dump-json (via YoutubeDL) without downloading.

    Returns {"title": str|None, "duration": float|None, "filesize_approx": int|None,
             "thumbnail": str|None, "id": str|None, "ext": str|None}

    Raises ValueError for invalid URL or when limits exceeded (>1200s, >50MB).
    Raises RuntimeError for yt-dlp failures.
    Propagates ImportError with a clear message if yt-dlp is not installed.
    """
    if not validate_youtube_url(url):
        raise ValueError(f"Invalid YouTube URL: {url!r}")

    try:
        import yt_dlp  # type: ignore
    except ImportError as exc:
        raise ImportError(
            "yt-dlp is required for YouTube downloads. Install with `pip install yt-dlp`."
        ) from exc

    cookie_opts, tmp_cookie = _ydl_opts_for_cookies(cookies_secret)
    try:
        ydl_opts: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            **cookie_opts,
        }
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
        except Exception as exc:  # yt_dlp.utils.DownloadError etc.
            raise RuntimeError(f"yt-dlp preflight failed for {url!r}: {exc}") from exc

        if info is None:
            raise RuntimeError(f"yt-dlp returned no info for {url!r}")

        # yt-dlp may return a playlist-shaped dict with 'entries'
        if isinstance(info, dict) and "entries" in info:
            entries = info.get("entries")
            # entries may be a generator
            try:
                first = next(iter(entries)) if entries is not None else None  # type: ignore[arg-type]
            except StopIteration:
                first = None
            if first is None:
                raise RuntimeError(f"yt-dlp returned empty playlist for {url!r}")
            info = first

        title = info.get("title")
        duration = info.get("duration")  # seconds
        # Prefer filesize_approx; fallback to filesize
        filesize_approx = info.get("filesize_approx")
        if filesize_approx is None:
            filesize_approx = info.get("filesize")
        # As a last resort, try requested_formats / formats max filesize
        if filesize_approx is None:
            fmts = info.get("requested_formats") or info.get("formats") or []
            try:
                sizes = [f.get("filesize") or f.get("filesize_approx") for f in fmts if isinstance(f, dict)]
                sizes = [s for s in sizes if isinstance(s, (int, float))]
                if sizes:
                    filesize_approx = max(sizes)
            except Exception:
                pass

        thumbnail = info.get("thumbnail")
        vid = info.get("id")
        ext = info.get("ext")

        # Enforce caps (PLAN.md 4/6) — give clear ValueErrors so the caller can
        # mark the job failed with a user-facing message.
        if isinstance(duration, (int, float)) and duration > MAX_DURATION_S:
            raise ValueError(f"YouTube video too long ({duration:.0f}s > {MAX_DURATION_S}s / 20 min)")
        if isinstance(filesize_approx, (int, float)) and filesize_approx > MAX_FILESIZE_BYTES:
            mb = filesize_approx / (1024 * 1024)
            raise ValueError(f"YouTube audio too large (~{mb:.1f} MB > 50 MB)")

        return {
            "title": title,
            "duration": float(duration) if isinstance(duration, (int, float)) else None,
            "filesize_approx": int(filesize_approx) if isinstance(filesize_approx, (int, float)) else None,
            "thumbnail": thumbnail,
            "id": vid,
            "ext": ext,
        }
    finally:
        if tmp_cookie:
            try:
                Path(tmp_cookie).unlink(missing_ok=True)  # type: ignore[attr-defined]
            except Exception:
                pass


def download_audio(url: str, out_path: str | os.PathLike[str], cookies_secret: str | None = None) -> str:
    """Download bestaudio for url to out_path (wav-ish). Returns out_path.

    Uses yt-dlp with format bestaudio/best and outtmpl=out_path. No
    postprocessor — caller is expected to ffmpeg-convert to 44.1 kHz stereo wav
    (see workers/separation.py). Handles cookies file via Secret Manager env
    or YT_COOKIES_FILE fallback.

    Raises ValueError for invalid URL, RuntimeError for yt-dlp failure.
    """
    if not validate_youtube_url(url):
        raise ValueError(f"Invalid YouTube URL: {url!r}")

    try:
        import yt_dlp  # type: ignore
    except ImportError as exc:
        raise ImportError(
            "yt-dlp is required for YouTube downloads. Install with `pip install yt-dlp`."
        ) from exc

    dest = str(out_path)
    Path(dest).parent.mkdir(parents=True, exist_ok=True)

    cookie_opts, tmp_cookie = _ydl_opts_for_cookies(cookies_secret)
    try:
        ydl_opts: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "format": "bestaudio/best",
            "outtmpl": dest,
            # Do NOT use postprocessors here — separation worker does ffmpeg conversion
            # explicitly so sample rate / channels are controlled in one place.
            **cookie_opts,
        }
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])
        except Exception as exc:
            raise RuntimeError(f"yt-dlp download failed for {url!r}: {exc}") from exc

        # yt-dlp may append an extension if outtmpl has no ext; check for that.
        p = Path(dest)
        if not p.exists():
            # Try with common extensions yt-dlp might have added
            for ext in (".webm", ".m4a", ".mp3", ".opus", ".wav", ".mkv", ".mp4"):
                cand = Path(str(dest) + ext)
                if cand.exists():
                    return str(cand)
            # Also try parent glob by stem
            for cand in p.parent.glob(p.name + ".*"):
                if cand.is_file():
                    return str(cand)
            raise RuntimeError(f"yt-dlp finished but output file not found at {dest!r}")

        return dest
    finally:
        if tmp_cookie:
            try:
                Path(tmp_cookie).unlink(missing_ok=True)  # type: ignore[attr-defined]
            except Exception:
                pass
