"""Local, credential-free checkpoints; the backend still owns every assignment."""

import base64
import hashlib
import importlib.metadata
import json
import math
import os
import re
import shutil
from pathlib import Path
from uuid import UUID, uuid4


def file_checksum(path: Path, check=lambda: None) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            check()
            digest.update(block)
    check()
    return base64.b64encode(digest.digest()).decode()


def matches_file(path: Path, size: int, checksum: str, check=lambda: None) -> bool:
    return (
        not path.is_symlink()
        and path.is_file()
        and path.stat().st_size == size
        and file_checksum(path, check) == checksum
    )


def atomic_json(path: Path, value) -> None:
    if path.is_symlink():
        raise RuntimeError("Worker state must not be a symbolic link")
    temporary = path.with_suffix(".tmp")
    if temporary.is_symlink():
        raise RuntimeError("Worker state must not be a symbolic link")
    with temporary.open("w", encoding="utf-8") as output:
        json.dump(value, output, allow_nan=False)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def installation_session(root: Path) -> str:
    """Persist claim intent before the first request, even if its reply is lost."""
    root.mkdir(parents=True, exist_ok=True)
    path = root / "session.json"
    if path.exists():
        try:
            if path.is_symlink() or path.stat().st_size > 1024:
                raise ValueError("Invalid session state")
            value = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(value, str):
                raise TypeError("Invalid session state")
            session = UUID(value)
            if session.version != 4 or str(session) != value:
                raise ValueError("Invalid session state")
            return value
        except (ValueError, TypeError):
            raise RuntimeError("Invalid local worker session") from None
    value = str(uuid4())
    atomic_json(path, value)
    return value


def bind_installation(
    root: Path,
    api_base_url: str,
    worker_id: str,
    *,
    active: bool,
    allow_rebind: bool = False,
) -> None:
    """Bind durable state without rewriting a legacy session or assignment."""
    path = root / "installation.json"
    expected = {
        "version": 1,
        "apiBaseUrl": api_base_url,
        "workerId": worker_id,
    }
    if not path.exists():
        if active and worker_id != "z440":
            raise RuntimeError(
                "Cannot change an unbound legacy worker identity while an active assignment journal exists"
            )
        atomic_json(path, expected)
        return
    try:
        if path.is_symlink() or path.stat().st_size > 4096:
            raise ValueError("Invalid installation state")
        value = json.loads(path.read_text(encoding="utf-8-sig"))
        if (
            not isinstance(value, dict)
            or set(value) != set(expected)
            or value.get("version") != 1
            or not isinstance(value.get("apiBaseUrl"), str)
            or not isinstance(value.get("workerId"), str)
        ):
            raise ValueError("Invalid installation state")
    except (ValueError, TypeError):
        raise RuntimeError("Invalid local worker installation identity") from None
    if value != expected:
        if active or not allow_rebind:
            suffix = (
                " while an active assignment journal exists"
                if active
                else "; rerun Configure-Worker.ps1 to change it explicitly"
            )
            raise RuntimeError(
                "Configured worker identity or API does not match this installation"
                + suffix
            )
        atomic_json(path, expected)


class Progress:
    """Reuse artifacts only for the same authorized job, input and processor."""

    def __init__(self, root: Path, separator: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "progress.json"
        self.separator = separator
        self.processor_fingerprint = None
        self.data = None
        if self.path.exists():
            if self.path.is_symlink() or self.path.stat().st_size > 32_768:
                raise RuntimeError("Invalid local processing checkpoint")
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                if data is not None:
                    self._validate(data)
                self.data = data
            except (ValueError, TypeError, KeyError):
                raise RuntimeError("Invalid local processing checkpoint") from None

    def _validate(self, data):
        if not isinstance(data, dict) or set(data) - {
            "version",
            "jobId",
            "fingerprint",
            "workDir",
            "downloadAttempts",
            "uploadAttempts",
            "inputDurationSeconds",
            "prepared",
            "output",
        }:
            raise ValueError("Invalid checkpoint fields")
        if data["version"] != 1:
            raise ValueError("Invalid checkpoint version")
        for key in ("downloadAttempts", "uploadAttempts"):
            if type(data[key]) is not int or not 0 <= data[key] <= 10:
                raise ValueError("Invalid attempt count")
        for key in ("jobId", "fingerprint", "workDir"):
            if not isinstance(data[key], str):
                raise TypeError("Invalid checkpoint identity")
        self._confined(data["workDir"])
        if "inputDurationSeconds" in data:
            self._duration(data["inputDurationSeconds"])
        for kind in ("prepared", "output"):
            artifact = data.get(kind)
            if artifact is None:
                continue
            if not isinstance(artifact, dict) or set(artifact) != {
                "file",
                "bytes",
                "sha256",
                "durationSeconds",
            }:
                raise ValueError("Invalid artifact")
            if type(artifact["bytes"]) is not int or artifact["bytes"] <= 0:
                raise ValueError("Invalid artifact size")
            self._duration(artifact["durationSeconds"])
            if len(base64.b64decode(artifact["sha256"], validate=True)) != 32:
                raise ValueError("Invalid artifact checksum")
            self._artifact_path(data, artifact["file"])

    @staticmethod
    def _duration(value):
        if (
            type(value) not in (int, float)
            or not math.isfinite(value)
            or not 0 < value < 600
        ):
            raise ValueError("Invalid artifact duration")

    def _confined(self, relative: str) -> Path:
        path = Path(relative)
        if path.is_absolute() or not path.parts or ".." in path.parts:
            raise ValueError("Invalid artifact path")
        current = self.root
        for part in path.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError("Artifact path must not contain symbolic links")
        if not current.resolve().is_relative_to(self.root):
            raise ValueError("Artifact path escaped state directory")
        return current

    def _artifact_path(self, data, relative: str) -> Path:
        if (
            not isinstance(relative, str)
            or Path(relative).is_absolute()
            or ".." in Path(relative).parts
        ):
            raise ValueError("Invalid artifact path")
        return self._confined(str(Path(data["workDir"]) / relative))

    def bind(self, assignment: dict) -> None:
        # Package metadata avoids importing the GPU framework into the supervisor.
        versions = {}
        for name in ("audio-separator", "onnxruntime-directml", "numpy", "soundfile"):
            try:
                versions[name] = importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError:
                versions[name] = None
        media = assignment["input"]
        processor = {"separator": file_checksum(self.separator), "versions": versions}
        self.processor_fingerprint = hashlib.sha256(
            json.dumps(processor, sort_keys=True).encode()
        ).hexdigest()
        fingerprint = hashlib.sha256(
            json.dumps(
                {
                    "input": {k: media[k] for k in ("extension", "bytes", "sha256")},
                    **processor,
                },
                sort_keys=True,
            ).encode()
        ).hexdigest()
        if (
            self.data
            and self.data["jobId"] == assignment["jobId"]
            and self.data["fingerprint"] == fingerprint
        ):
            return
        self.data = {
            "version": 1,
            "jobId": assignment["jobId"],
            "fingerprint": fingerprint,
            "workDir": str(Path("jobs") / assignment["jobId"] / uuid4().hex),
            "downloadAttempts": 0,
            "uploadAttempts": 0,
        }
        self.work.mkdir(parents=True)
        self.save()

    @property
    def work(self) -> Path:
        return self._confined(self.data["workDir"])

    def local_path(self, relative: str | Path) -> Path:
        """Validate parent links before a child is allowed to write this path."""
        return self._artifact_path(self.data, str(relative))

    def artifact(self, kind: str, check=lambda: None) -> Path | None:
        value = self.data.get(kind)
        if not value:
            return None
        path = self._artifact_path(self.data, value["file"])
        if matches_file(path, value["bytes"], value["sha256"], check):
            return path
        self.data.pop(kind)
        self.save()
        return None

    def record(
        self, kind: str, path: Path, duration: float, check=lambda: None
    ) -> None:
        self._duration(duration)
        relative = path.relative_to(self.work)
        self._artifact_path(self.data, str(relative))
        self.data[kind] = {
            "file": str(relative),
            "bytes": path.stat().st_size,
            "sha256": file_checksum(path, check),
            "durationSeconds": duration,
        }
        self.save()

    def save(self) -> None:
        if self.data is not None:
            self._validate(self.data)
        atomic_json(self.path, self.data)

    def purge_job(self, job_id: str) -> None:
        """Remove every processor revision for one validated job before acknowledging."""
        if not isinstance(job_id, str) or not re.fullmatch(r"[a-f0-9]{24}", job_id):
            raise ValueError("Invalid cleanup job identity")
        directory = self._confined(str(Path("jobs") / job_id))
        if directory.exists():
            shutil.rmtree(directory)
        if directory.exists():
            raise OSError("Job artifacts remain after cleanup")
        if self.data and self.data["jobId"] == job_id:
            self.clear()

    def clear(self) -> None:
        self.data = None
        self.save()
