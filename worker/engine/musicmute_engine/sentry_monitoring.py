"""Minimal, fail-closed Sentry reporting for unexpected engine failures."""

from __future__ import annotations

import os
import re
from typing import Any

_sdk: Any = None
_SAFE_SYMBOL = re.compile(r"^[A-Za-z_][A-Za-z0-9_.<>]{0,127}$")
_SAFE_SOURCE = re.compile(r"^[A-Za-z0-9_./-]+\.py$")


def sanitize_event(event: dict[str, Any], _hint: Any) -> dict[str, Any]:
    """Allow only error identity and package-relative code frames."""
    allowed = {
        name: event[name]
        for name in ("event_id", "timestamp", "level", "platform", "release", "environment")
        if name in event
    }
    values = event.get("exception", {}).get("values", [])
    exceptions = []
    for value in values[:4]:
        raw_type = value.get("type", "Error")
        frames = []
        for frame in value.get("stacktrace", {}).get("frames", [])[-30:]:
            filename = str(frame.get("filename", "")).replace("\\", "/")
            package_path = filename.rsplit("/musicmute_engine/", 1)
            safe_path = (
                "musicmute_engine/" + package_path[-1]
                if len(package_path) == 2
                and _SAFE_SOURCE.fullmatch(package_path[-1])
                and ".." not in package_path[-1].split("/")
                else "[external]"
            )
            function = str(frame.get("function", ""))
            safe_frame: dict[str, Any] = {"filename": safe_path}
            if _SAFE_SYMBOL.fullmatch(function):
                safe_frame["function"] = function
            if isinstance(frame.get("lineno"), int):
                safe_frame["lineno"] = frame["lineno"]
            frames.append(safe_frame)
        sanitized = {
            "type": raw_type if isinstance(raw_type, str) and _SAFE_SYMBOL.fullmatch(raw_type) else "Error",
            "value": "Unexpected engine failure",
        }
        if frames:
            sanitized["stacktrace"] = {"frames": frames}
        exceptions.append(sanitized)
    allowed["exception"] = {"values": exceptions}
    allowed["tags"] = {"component": "worker-engine"}
    return allowed


def initialize() -> None:
    global _sdk
    if os.environ.get("MUSICMUTE_SENTRY_ENGINE_ENABLED") != "true":
        return
    try:
        import sentry_sdk

        dsn = os.environ["MUSICMUTE_SENTRY_ENGINE_DSN"]
        if not dsn.startswith("https://"):
            return
        sentry_sdk.init(
            dsn=dsn,
            environment=os.environ.get("MUSICMUTE_SENTRY_ENVIRONMENT", "production"),
            release=os.environ.get("MUSICMUTE_SENTRY_RELEASE"),
            default_integrations=False,
            auto_enabling_integrations=False,
            send_default_pii=False,
            max_breadcrumbs=0,
            traces_sample_rate=0,
            include_local_variables=False,
            include_source_context=False,
            before_send=sanitize_event,
        )
        _sdk = sentry_sdk
    except Exception:
        _sdk = None


def capture_unexpected(error: Exception) -> None:
    if _sdk is None:
        return
    try:
        _sdk.capture_exception(error)
        _sdk.flush(timeout=1.5)
    except Exception:
        pass  # Telemetry must not alter worker exit behavior.
