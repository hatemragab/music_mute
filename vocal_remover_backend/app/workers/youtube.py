"""Thin re-export of services.youtube for backward compat.

Workers that previously imported from app.workers.youtube continue to work;
prefer `from app.services.youtube import ...` in new code.
"""

from __future__ import annotations

from app.services.youtube import (  # noqa: F401
    MAX_DURATION_S,
    MAX_FILESIZE_BYTES,
    download_audio,
    preflight,
    validate_youtube_url,
)

__all__ = [
    "MAX_DURATION_S",
    "MAX_FILESIZE_BYTES",
    "validate_youtube_url",
    "preflight",
    "download_audio",
]
