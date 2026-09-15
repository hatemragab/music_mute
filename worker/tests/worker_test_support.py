"""Explicit synthetic approved bindings for isolated supervisor unit tests."""

import json
import shutil
from pathlib import Path
from musicmute_worker.config import Config
from musicmute_worker.launcher import InstallationBinding
from musicmute_worker.runtime_types import StatePaths
from musicmute_worker.worker import Worker


class SyntheticQualifiedWorker(Worker):
    """Queue/ownership unit fixture; does not claim real GPU qualification.

    Runtime admission has its own tests using the actual Worker. These existing
    queue tests substitute only the admission boundary, preserving their original
    fake separators and transport while testing ownership/recovery behavior.
    """

    def _validate_claim_runtime(self):
        return None

    def _media_tools(self):
        return {
            name: Path(shutil.which(name)).resolve() for name in ("ffmpeg", "ffprobe")
        }


INSTALLATION_ID = "11111111-1111-4111-8111-111111111111"


def config_document(root):
    paths = {name: str(root / name) for name in StatePaths.__annotations__}
    path = root / "config" / "worker.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path, {
        "schema_version": 3,
        "worker_id": "fixture-worker",
        "installation_id": INSTALLATION_ID,
        "api_base_url": "https://api.example.com/api/v1",
        "separator": str(
            root / "releases" / "r1" / "musicmute_worker" / "separation.py"
        ),
        "paths": paths,
    }


def config(api_base_url, state_dir, separator, **kwargs):
    root = state_dir.parent.resolve()
    paths = StatePaths(
        root / "identity",
        root / "config",
        root / "state-meta",
        root / "releases",
        root / "models",
        state_dir.resolve(),
        root / "events",
    )
    worker_id = kwargs.pop("worker_id", "fixture-worker")
    binding = InstallationBinding(
        INSTALLATION_ID, worker_id, "a" * 64, "b" * 64, api_base_url
    )
    paths.identity.mkdir(parents=True, exist_ok=True)
    path = paths.identity / "installation.json"
    if not path.exists():
        path.write_text(json.dumps(binding.as_dict()))
    return Config(
        api_base_url,
        state_dir.resolve(),
        separator.resolve(),
        worker_id=worker_id,
        installation_id=INSTALLATION_ID,
        paths=paths,
        **kwargs,
    )
