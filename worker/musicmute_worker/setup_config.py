"""Protected bootstrap-issued setup configuration.

This is the file the native entrypoint writes and then hands to
`musicmute_worker.setup_host`. It is not the processing `Config`: it exists
before a worker identity is paired and therefore carries no `worker_id`,
separator or journal choice. It also never selects an implementation — the OS
host comes from `platforms.registry` and the trust root from the verified
bootstrap stage named here.
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from .config import https_url
from .runtime_types import StatePaths

MAX_CONFIG_BYTES = 16384
_FIELDS = {
    "schemaVersion",
    "apiBaseUrl",
    "paths",
    "distributionOrigin",
    "bootstrapRootPath",
    "launcherPath",
    "launcherBuild",
    "installerBuild",
}
_STAGE = re.compile(r"bootstrap-[a-f0-9]{64}")


def _origin(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?", value
    ):
        raise ValueError("Invalid distribution origin")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ValueError("Invalid distribution origin")
    return value


def _inside(path, root, *, expect_dir):
    """Confine a bootstrap path to its verified stage without following links."""
    if (
        not path.is_absolute()
        or path != path.resolve()
        or path.is_symlink()
        or not path.is_relative_to(root)
    ):
        raise ValueError("Invalid bootstrap stage path")
    if expect_dir:
        if not path.is_dir():
            raise ValueError("Invalid bootstrap stage path")
    elif not path.is_file():
        raise ValueError("Invalid bootstrap stage path")
    return path


@dataclass(frozen=True)
class SetupHostConfig:
    api_base_url: str
    paths: StatePaths
    distribution_origin: str
    bootstrap_root: Path
    launcher_path: Path
    launcher_build: int
    installer_build: int

    def __post_init__(self):
        if not self.launcher_path.is_relative_to(self.paths.releases):
            raise ValueError("Launcher must belong to the protected releases root")
        if not self.bootstrap_root.is_relative_to(self.stage):
            raise ValueError("Trust root must belong to the selected bootstrap stage")

    @property
    def stage(self):
        return (
            self.paths.releases
            / self.launcher_path.relative_to(self.paths.releases).parts[0]
        )

    @classmethod
    def load(cls, path: Path):
        if (
            not path.is_absolute()
            or path.is_symlink()
            or not path.is_file()
            or path.stat().st_size > MAX_CONFIG_BYTES
        ):
            raise ValueError("Invalid protected setup configuration file")
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict) or set(data) != _FIELDS:
            raise ValueError("Unknown setup configuration fields")
        if type(data["schemaVersion"]) is not int or data["schemaVersion"] != 3:
            raise ValueError(
                "Incompatible setup schema; rerun the native installer without "
                "erasing journals"
            )
        base = https_url(data["apiBaseUrl"]).rstrip("/")
        if urlsplit(base).query or not base.endswith("/api/v1"):
            raise ValueError("api_base_url must end with /api/v1 and have no query")
        raw_paths = data["paths"]
        if (
            not isinstance(raw_paths, dict)
            or set(raw_paths) != set(StatePaths.__annotations__)
            or any(
                not isinstance(value, str)
                or not value
                or len(value) > 4096
                or Path(value) != Path(value).resolve()
                for value in raw_paths.values()
            )
        ):
            raise ValueError("Explicit canonical state paths are required")
        paths = StatePaths(**{key: Path(value) for key, value in raw_paths.items()})
        if path.resolve().parent != paths.config:
            raise ValueError(
                "Configuration must be in its explicit protected config root"
            )
        build = data["launcherBuild"]
        installer = data["installerBuild"]
        for value in (build, installer):
            if type(value) is not int or not 1 <= value <= 2**31 - 1:
                raise ValueError("Invalid bootstrap build identity")
        launcher = _inside(Path(data["launcherPath"]), paths.releases, expect_dir=False)
        # The launcher lives at <stage>/python/(bin/)python3, so the stage is the
        # first component under the releases root, not the interpreter's parent.
        relative = launcher.relative_to(paths.releases)
        stage = paths.releases / relative.parts[0]
        if len(relative.parts) < 2 or not _STAGE.fullmatch(stage.name):
            raise ValueError("Invalid bootstrap stage")
        if not launcher.stat().st_mode & 0o100:
            raise ValueError("Bootstrap interpreter is not executable")
        root = _inside(Path(data["bootstrapRootPath"]), stage, expect_dir=False)
        return cls(
            base,
            paths,
            _origin(data["distributionOrigin"]),
            root,
            launcher,
            build,
            installer,
        )
