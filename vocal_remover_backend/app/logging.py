from __future__ import annotations

import logging
import os


def setup_logging() -> None:
    level_name = os.environ.get("LOG_LEVEL") or _settings_log_level()
    level = getattr(logging, level_name.upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
        force=False,
    )
    # Quieten noisy libs at info
    for name in ("boto3", "botocore", "urllib3"):
        logging.getLogger(name).setLevel(logging.WARNING)


def _settings_log_level() -> str:
    try:
        from app.config import get_settings

        return get_settings().LOG_LEVEL
    except Exception:
        return "info"
