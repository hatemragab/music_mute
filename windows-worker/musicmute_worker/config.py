"""Non-secret worker configuration; credentials stay in the process environment."""

import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

_ALLOWED_FIELDS = {
    "api_base_url",
    "state_dir",
    "separator",
    "processing_timeout_seconds",
    "output_max_bytes",
    "transfer_attempts",
    "transfer_retry_budget_seconds",
    "claim_wait_seconds",
    "reuse_separator",
    "worker_id",
}
_WORKER_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")


def https_url(value: str, *, allow_http: bool = False) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme not in (("https", "http") if allow_http else ("https",))
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or any(ord(c) < 33 or ord(c) == 127 for c in value)
    ):
        raise ValueError(
            "A valid HTTPS URL without credentials or fragment is required"
        )
    return value


def validated_worker_id(value: object) -> str:
    if not isinstance(value, str) or not _WORKER_ID.fullmatch(value):
        raise ValueError(
            "worker_id must be 1..64 lowercase letters, digits, or hyphens and start with a letter or digit"
        )
    return value


@dataclass(frozen=True)
class Config:
    api_base_url: str
    state_dir: Path
    separator: Path
    processing_timeout_seconds: int = 7200
    output_max_bytes: int = 30_000_000
    transfer_attempts: int = 5
    transfer_retry_budget_seconds: int = 120
    claim_wait_seconds: int = 25
    reuse_separator: bool = True
    worker_id: str = "z440"

    @classmethod
    def load(cls, path: Path) -> "Config":
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict) or set(data) - _ALLOWED_FIELDS:
            raise ValueError(
                "Unknown configuration fields; secrets belong in MUSICMUTE_WORKER_SECRET"
            )
        base = https_url(data["api_base_url"]).rstrip("/")
        if urlsplit(base).query or not base.endswith("/api/v1"):
            raise ValueError("api_base_url must end with /api/v1 and have no query")
        root = path.resolve().parent
        timeout = data.get("processing_timeout_seconds", 7200)
        max_bytes = data.get("output_max_bytes", 30_000_000)
        attempts = data.get("transfer_attempts", 5)
        budget = data.get("transfer_retry_budget_seconds", 120)
        wait = data.get("claim_wait_seconds", 25)
        reuse = data.get("reuse_separator", True)
        worker_id = validated_worker_id(data.get("worker_id", "z440"))
        if type(timeout) is not int or not 60 <= timeout <= 86400:
            raise ValueError("processing_timeout_seconds must be 60..86400")
        if type(max_bytes) is not int or not 1024 <= max_bytes <= 100_000_000:
            raise ValueError("output_max_bytes must be 1024..100000000")
        if type(attempts) is not int or not 1 <= attempts <= 10:
            raise ValueError("transfer_attempts must be 1..10")
        if type(budget) is not int or not 15 <= budget <= 600:
            raise ValueError("transfer_retry_budget_seconds must be 15..600")
        if type(wait) is not int or not 0 <= wait <= 25:
            raise ValueError("claim_wait_seconds must be 0..25")
        if type(reuse) is not bool:
            raise ValueError("reuse_separator must be a boolean")
        return cls(
            base,
            (root / data.get("state_dir", "state")).resolve(),
            (root / data.get("separator", "separate.py")).resolve(),
            timeout,
            max_bytes,
            attempts,
            budget,
            wait,
            reuse,
            worker_id,
        )


def configure_installation(
    root: Path, api_base_url: str, worker_id: str
) -> None:
    """Persist setup only while the worker's machine-wide exclusion is held."""
    from .processes import SingleInstance
    from .progress import atomic_json, bind_installation

    root = root.resolve()
    base = https_url(api_base_url).rstrip("/")
    if urlsplit(base).query or not base.endswith("/api/v1"):
        raise ValueError("api_base_url must end with /api/v1 and have no query")
    worker_id = validated_worker_id(worker_id)
    config_path = root / "worker.config.json"
    example_path = root / "worker.config.example.json"

    # Windows uses one named machine-wide mutex regardless of this fallback path.
    # The path keeps local POSIX behavior testable without weakening Windows.
    with SingleInstance(root / "state"):
        source = config_path if config_path.exists() else example_path
        if (
            source.is_symlink()
            or not source.is_file()
            or source.stat().st_size > 32_768
        ):
            raise RuntimeError("Invalid worker configuration file")
        try:
            data = json.loads(source.read_text(encoding="utf-8-sig"))
        except (ValueError, UnicodeError):
            raise RuntimeError("Invalid worker configuration file") from None
        if not isinstance(data, dict) or set(data) - _ALLOWED_FIELDS:
            raise RuntimeError("Invalid worker configuration file")
        state_value = data.get("state_dir", "state")
        if not isinstance(state_value, str) or not state_value:
            raise RuntimeError("Invalid worker state directory")
        state_dir = (root / state_value).resolve()
        state_dir.mkdir(parents=True, exist_ok=True)
        active_path = state_dir / "active.json"
        active = False
        if active_path.exists():
            if active_path.is_symlink() or active_path.stat().st_size > 8192:
                raise RuntimeError("Invalid local assignment journal")
            try:
                active = (
                    json.loads(active_path.read_text(encoding="utf-8")) is not None
                )
            except (ValueError, UnicodeError):
                raise RuntimeError("Invalid local assignment journal") from None

        previous_url = data.get("api_base_url") if config_path.exists() else None
        previous_id = data.get("worker_id", "z440") if config_path.exists() else None
        if active and (
            previous_url is not None
            and (previous_url.rstrip("/") != base or previous_id != worker_id)
        ):
            raise RuntimeError(
                "Cannot change worker identity or backend URL while an active assignment journal exists"
            )

        # This call validates every existing binding before either file changes.
        # Explicit setup may rebind only an idle installation.
        bind_installation(
            state_dir,
            base,
            worker_id,
            active=active,
            allow_rebind=True,
        )
        data["api_base_url"] = base
        data["worker_id"] = worker_id
        atomic_json(config_path, data)
