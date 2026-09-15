"""Non-secret worker configuration; credentials stay in the process environment."""

import json
import re
from dataclasses import dataclass, field
from .runtime_types import StatePaths, uuid4_string
from pathlib import Path
from urllib.parse import urlsplit

_ALLOWED_FIELDS = {
    "api_base_url",
    "separator",
    "processing_timeout_seconds",
    "output_max_bytes",
    "transfer_attempts",
    "transfer_retry_budget_seconds",
    "claim_wait_seconds",
    "reuse_separator",
    "worker_id",
    "installation_id",
    "schema_version",
    "paths",
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
    worker_id: str = field(kw_only=True)
    installation_id: str = field(kw_only=True)
    paths: StatePaths = field(kw_only=True)

    def __post_init__(self):
        validated_worker_id(self.worker_id)
        uuid4_string(self.installation_id)
        if not self.separator.is_absolute() or not self.state_dir.is_absolute():
            raise ValueError("Explicit absolute processing paths are required")
        if self.state_dir != self.paths.journals:
            raise ValueError("Assignment state must use the configured journals root")

    @classmethod
    def load(cls, path: Path) -> "Config":
        if path.is_symlink() or path.stat().st_size > 32768:
            raise ValueError("Invalid protected configuration file")
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict) or set(data) - _ALLOWED_FIELDS:
            raise ValueError(
                "Unknown configuration fields; secrets belong in MUSICMUTE_WORKER_SECRET"
            )
        base = https_url(data["api_base_url"]).rstrip("/")
        if urlsplit(base).query or not base.endswith("/api/v1"):
            raise ValueError("api_base_url must end with /api/v1 and have no query")
        if (
            data.get("schema_version") != 3
            or type(data.get("schema_version")) is not int
        ):
            raise ValueError(
                "Incompatible configuration schema; reinstall and re-enroll without erasing journals"
            )
        raw_paths = data.get("paths")
        if not isinstance(raw_paths, dict) or set(raw_paths) != set(
            StatePaths.__annotations__
        ):
            raise ValueError("Explicit state paths are required")
        if any(
            not isinstance(value, str) or not value or len(value) > 4096
            for value in raw_paths.values()
        ):
            raise ValueError("Invalid explicit state paths")
        paths = StatePaths(**{key: Path(value) for key, value in raw_paths.items()})
        if not path.is_absolute() or path.resolve().parent != paths.config:
            raise ValueError(
                "Configuration must be in its explicit protected config root"
            )
        installation_id = uuid4_string(data.get("installation_id"))
        if not isinstance(data.get("separator"), str) or not data["separator"]:
            raise ValueError("Explicit separator path required")
        separator = Path(data["separator"])
        if (
            not separator.is_absolute()
            or paths.releases not in separator.resolve().parents
        ):
            raise ValueError("Separator must belong to the explicitly selected release")
        timeout = data.get("processing_timeout_seconds", 7200)
        max_bytes = data.get("output_max_bytes", 30_000_000)
        attempts = data.get("transfer_attempts", 5)
        budget = data.get("transfer_retry_budget_seconds", 120)
        wait = data.get("claim_wait_seconds", 25)
        reuse = data.get("reuse_separator", True)
        worker_id = validated_worker_id(data.get("worker_id"))
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
            paths.journals,
            separator,
            timeout,
            max_bytes,
            attempts,
            budget,
            wait,
            reuse,
            worker_id=worker_id,
            installation_id=installation_id,
            paths=paths,
        )
