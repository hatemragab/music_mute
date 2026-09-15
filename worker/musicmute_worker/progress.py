"""Local, credential-free checkpoints; the backend still owns every assignment."""

import base64
import hashlib
import importlib.metadata
import json
import os
import re
import shutil
from pathlib import Path
from uuid import UUID, uuid4

from .media_limits import MediaLimits, effective_media_limits


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
            if (
                not isinstance(value, dict)
                or set(value) != {"schemaVersion", "sessionId"}
                or type(value["schemaVersion"]) is not int
                or value["schemaVersion"] != 3
            ):
                raise TypeError("Invalid session state")
            session = UUID(value["sessionId"])
            if session.version != 4 or str(session) != value["sessionId"]:
                raise ValueError("Invalid session state")
            return value["sessionId"]
        except (ValueError, TypeError):
            raise RuntimeError("Invalid local worker session") from None
    value = str(uuid4())
    atomic_json(path, {"schemaVersion": 3, "sessionId": value})
    return value


def bind_installation(config) -> None:
    """Validate approved identity before opening or changing assignment state."""
    from .launcher import InstallationBinding

    binding = InstallationBinding.load(config.paths.identity / "installation.json")
    if (
        binding.installation_id != config.installation_id
        or binding.worker_id != config.worker_id
        or binding.api_base_url != config.api_base_url
    ):
        raise RuntimeError(
            "Configured worker identity or API does not match this installation"
        )


class Progress:
    """Reuse artifacts only for the same authorized job, input and processor."""

    def __init__(self, root: Path, separator: Path, runtime=None):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "progress.json"
        self.separator = separator
        self.runtime = runtime
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
            "processingLimits",
        }:
            raise ValueError("Invalid checkpoint fields")
        if type(data["version"]) is not int or data["version"] != 3:
            raise ValueError("Invalid checkpoint version")
        for key in ("downloadAttempts", "uploadAttempts"):
            if type(data[key]) is not int or not 0 <= data[key] <= 10:
                raise ValueError("Invalid attempt count")
        for key in ("jobId", "fingerprint", "workDir"):
            if not isinstance(data[key], str):
                raise TypeError("Invalid checkpoint identity")
        self._confined(data["workDir"])
        limits = effective_media_limits(data, 100_000_000, 86400)
        if "inputDurationSeconds" in data:
            self._duration(data["inputDurationSeconds"], limits)
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
            self._duration(artifact["durationSeconds"], limits)
            if len(base64.b64decode(artifact["sha256"], validate=True)) != 32:
                raise ValueError("Invalid artifact checksum")
            self._artifact_path(data, artifact["file"])

    @staticmethod
    def _duration(value, limits=None):
        if not (limits or MediaLimits()).accepts_duration(value):
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
        for name in (
            "onnxruntime",
            "onnxruntime-directml",
            "onnxruntime-gpu",
            "onnxruntime-migraphx",
            "onnxruntime-openvino",
            "numpy",
            "soundfile",
        ):
            try:
                versions[name] = importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError:
                versions[name] = None
        media = assignment["input"]
        processor = {
            "separator": file_checksum(self.separator),
            "versions": versions,
            "runtime": self.runtime.fingerprint(self.separator)
            if self.runtime
            else None,
        }
        self.processor_fingerprint = hashlib.sha256(
            json.dumps(processor, sort_keys=True).encode()
        ).hexdigest()
        fingerprint = hashlib.sha256(
            json.dumps(
                {
                    "input": {k: media[k] for k in ("extension", "bytes", "sha256")},
                    **processor,
                    **(
                        {
                            "processingLimits": effective_media_limits(
                                assignment, 100_000_000, 86400
                            ).to_wire()
                        }
                        if "processingLimits" in assignment
                        else {}
                    ),
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
            "version": 3,
            "jobId": assignment["jobId"],
            "fingerprint": fingerprint,
            "workDir": str(Path("jobs") / assignment["jobId"] / uuid4().hex),
            "downloadAttempts": 0,
            "uploadAttempts": 0,
            **(
                {
                    "processingLimits": effective_media_limits(
                        assignment, 100_000_000, 86400
                    ).to_wire()
                }
                if "processingLimits" in assignment
                else {}
            ),
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
        self._duration(duration, effective_media_limits(self.data, 100_000_000, 86400))
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
