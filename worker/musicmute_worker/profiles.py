"""Immutable GPU recipes and verified private assets; no numerical imports.

The caller supplies the manifest digest authenticated by ReleaseVerifier. A
checksum fetched next to an unsigned manifest is deliberately not a trust root.
Candidate recipes may be prepared for V01, but cannot enter claim selection.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import struct
import stat
import tarfile
import zipfile
import time
import urllib.request
import wave
from urllib.parse import urlsplit

from .runtime_types import SETUP_REASON_CODES, QualificationReport, sha256_string

PROVIDERS = {
    "CUDAExecutionProvider": ("onnxruntime-gpu", {"device_id": "0"}),
    "DmlExecutionProvider": ("onnxruntime-directml", {"device_id": "0"}),
    "CoreMLExecutionProvider": (
        "onnxruntime",
        {
            "ModelFormat": "MLProgram",
            "MLComputeUnits": "CPUAndGPU",
            "RequireStaticInputShapes": "1",
            "EnableOnSubgraphs": "0",
            "ProfileComputePlan": "1",
        },
    ),
    "MIGraphXExecutionProvider": ("onnxruntime-migraphx", {"device_id": "0"}),
    "OpenVINOExecutionProvider": ("onnxruntime-openvino", {"device_type": "GPU"}),
    "ArmNNExecutionProvider": ("onnxruntime", {}),  # Vocabulary only; unavailable.
}
KIM_SHA256 = "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b"
KIM_BYTES = 66_759_214
SMOKE_SHA256 = "dffe793207240b39f03c00eae05267f29548804a985c2e3179d1669a6e0e7065"


class ProfileError(RuntimeError):
    def __init__(self, code="DEPENDENCY_RECIPE_UNAVAILABLE"):
        if code not in SETUP_REASON_CODES:
            raise ValueError("Unknown safe setup reason")
        super().__init__(code)
        self.code = code


def provider_options(provider: str, options: object) -> dict[str, str]:
    """Exact recipes: never AUTO/HETERO/CPU or an arbitrary provider fallback."""
    # F01 has no verified ArmNN binary or GPU selector contract. Do not assume an
    # unverified option selects GPU inside an EP that may itself execute on CPU.
    if provider == "ArmNNExecutionProvider":
        raise ProfileError("DEPENDENCY_RECIPE_UNAVAILABLE")
    if (
        not isinstance(provider, str)
        or provider not in PROVIDERS
        or not isinstance(options, dict)
    ):
        raise ProfileError("GPU_PROVIDER_UNAVAILABLE")
    required = PROVIDERS[provider][1]
    if options != required:
        raise ProfileError("GPU_PROVIDER_UNAVAILABLE")
    return dict(required)


def digest_file(path: Path) -> str:
    with path.open("rb") as source:
        digest = hashlib.sha256()
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@dataclass(frozen=True)
class Asset:
    filename: str
    url: str
    sha256: str
    bytes: int

    def __post_init__(self):
        url = urlsplit(self.url)
        if (
            not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.+-]{0,199}", self.filename)
            or (
                (url.scheme != "https" or not url.hostname)
                and self.url != "builtin:kim-smoke-v1"
            )
            or url.username
            or url.password
            or url.fragment
            or type(self.bytes) is not int
            or not 0 < self.bytes <= 8 * 1024**3
        ):
            raise ProfileError()
        sha256_string(self.sha256)
        if self.url == "builtin:kim-smoke-v1" and (
            self.sha256 != SMOKE_SHA256 or self.bytes != 352844
        ):
            raise ProfileError()


def verified_asset(path: Path, asset: Asset) -> Path:
    if (
        path.is_symlink()
        or not path.is_file()
        or path.stat().st_size != asset.bytes
        or digest_file(path) != asset.sha256
    ):
        raise ProfileError(
            "MODEL_INTEGRITY_FAILED"
            if asset.sha256 == KIM_SHA256
            else "DEPENDENCY_RECIPE_UNAVAILABLE"
        )
    return path


def fetch_asset(asset: Asset, cache: Path) -> Path:
    """Bounded streaming, verified digest/length, atomic publication of bytes."""
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    if cache.is_symlink():
        raise ProfileError()
    target = cache / (asset.sha256 + "-" + asset.filename)
    if target.exists() or target.is_symlink():
        return verified_asset(target, asset)
    if asset.url == "builtin:kim-smoke-v1":
        payload = smoke_fixture()
        with target.open("xb") as output:
            output.write(payload)
        return verified_asset(target, asset)
    if shutil.disk_usage(cache).free < asset.bytes + 64 * 1024**2:
        raise ProfileError("INSUFFICIENT_DISK")
    descriptor, name = tempfile.mkstemp(prefix="download-", dir=cache)
    partial = Path(name)
    deadline = time.monotonic() + 300
    try:
        with (
            os.fdopen(descriptor, "wb") as output,
            urllib.request.urlopen(asset.url, timeout=30) as response,
        ):
            if urlsplit(response.url).scheme != "https":
                raise ProfileError()
            total = 0
            while block := response.read(min(1024 * 1024, asset.bytes - total + 1)):
                if time.monotonic() > deadline:
                    raise ProfileError()
                total += len(block)
                if total > asset.bytes:
                    raise ProfileError()
                output.write(block)
            output.flush()
            os.fsync(output.fileno())
        verified_asset(partial, asset)
        os.replace(partial, target)
        return target
    except (OSError, ValueError) as error:
        raise ProfileError() from error
    finally:
        partial.unlink(missing_ok=True)


def smoke_fixture() -> bytes:
    def triangle(frame, frequency):
        phase = ((frame * frequency) % 44100) * 4
        return (
            phase
            if phase < 44100
            else 88200 - phase
            if phase < 132300
            else phase - 176400
        )

    pcm = bytearray()
    for frame in range(88200):
        pcm.extend(
            struct.pack(
                "<hh",
                triangle(frame, 220) * 10000 // 44100,
                triangle(frame, 330) * 8000 // 44100,
            )
        )
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(44100)
        output.writeframes(pcm)
    return buffer.getvalue()


@dataclass(frozen=True)
class Profile:
    profile_id: str
    os: str
    arch: str
    vendor: str
    minimum_os: str
    provider: str
    options: dict[str, str]
    lock_sha256: str
    model: Asset
    fixture: Asset
    reference: Asset | None
    max_duration_seconds: int
    max_ram_bytes: int
    max_wall_seconds: int
    reference_max_abs: float
    reference_rms: float
    status: str
    evidence_sha256: str | None
    priority: int

    @classmethod
    def load(cls, path: Path, expected_sha256: str) -> "Profile":
        sha256_string(expected_sha256)
        if (
            path.is_symlink()
            or path.stat().st_size > 65536
            or digest_file(path) != expected_sha256
        ):
            raise ProfileError("UPDATE_SIGNATURE_INVALID")
        value = json.loads(path.read_text())
        if not isinstance(value, dict) or set(value) != set(cls.__annotations__):
            raise ProfileError()
        for key in ("model", "fixture", "reference"):
            if value[key] is not None:
                value[key] = Asset(**value[key])
        result = cls(**value)
        if (
            not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", result.profile_id)
            or result.os not in ("macos", "windows", "linux")
            or result.arch not in ("arm64", "x64")
            or result.status not in ("candidate", "qualified")
            or result.model.sha256 != KIM_SHA256
            or result.model.bytes != KIM_BYTES
        ):
            raise ProfileError()
        provider_options(result.provider, result.options)
        sha256_string(result.lock_sha256)
        for key, ceiling in (
            ("max_duration_seconds", 86400),
            ("max_ram_bytes", 1024**4),
            ("max_wall_seconds", 86400),
        ):
            if (
                type(getattr(result, key)) is not int
                or not 0 < getattr(result, key) <= ceiling
            ):
                raise ProfileError()
        if type(result.priority) is not int or not 0 <= result.priority <= 100:
            raise ProfileError()
        for key in ("reference_max_abs", "reference_rms"):
            if (
                type(getattr(result, key)) not in (int, float)
                or not 0 <= getattr(result, key) <= 1
            ):
                raise ProfileError()
        if result.status == "qualified":
            sha256_string(result.evidence_sha256)
            if result.reference is None:
                raise ProfileError()
        return result


@dataclass(frozen=True)
class PreparedRuntime:
    python: Path
    profile: Profile
    model: Path
    ffmpeg: Path
    root: Path
    versions: dict[str, str]
    qualification_report: dict | None = None
    files_sha256: dict[str, str] = field(default_factory=dict)
    ffprobe: Path | None = None
    runtime_inventory: dict = field(default_factory=dict)

    def assert_claim_ready(self):
        report = self.qualification_report
        if (
            self.profile.status != "qualified"
            or not self.profile.evidence_sha256
            or not isinstance(report, dict)
        ):
            raise ProfileError("GPU_QUALIFICATION_FAILED")
        if set(report) != set(QualificationReport.__annotations__):
            raise ProfileError("GPU_QUALIFICATION_FAILED")
        if (
            type(report["wallMilliseconds"]) is not int
            or not 0
            < report["wallMilliseconds"]
            <= self.profile.max_wall_seconds * 1000
            or type(report["peakRamBytes"]) is not int
            or not 0 < report["peakRamBytes"] <= self.profile.max_ram_bytes
        ):
            raise ProfileError("GPU_QUALIFICATION_FAILED")
        expected = {
            "profileId": self.profile.profile_id,
            "provider": self.profile.provider,
            "modelSha256": self.profile.model.sha256,
            "fixtureSha256": self.profile.fixture.sha256,
        }
        if (
            any(report.get(key) != value for key, value in expected.items())
            or any(
                report.get(key) is not True
                for key in (
                    "acceleratorUsed",
                    "outputValid",
                    "referenceCheckPassed",
                    "serviceContextPassed",
                )
            )
            or report.get("reasonCodes") != []
        ):
            raise ProfileError("GPU_QUALIFICATION_FAILED")
        verified_asset(self.model, self.profile.model)
        if (
            not self.runtime_inventory
            or runtime_inventory(self.root) != self.runtime_inventory
        ):
            raise ProfileError("DEPENDENCY_RECIPE_UNAVAILABLE")
        for path in (self.python, self.ffmpeg, self.ffprobe):
            if (
                path is None
                or not path.is_relative_to(self.root)
                or str(path.relative_to(self.root)) not in self.runtime_inventory
                or not path.is_file()
                or not os.access(path, os.X_OK)
            ):
                raise ProfileError()
        if self.python != self.root / "venv" / (
            "Scripts/python.exe" if self.profile.os == "windows" else "bin/python"
        ):
            raise ProfileError()

    def descriptor(self) -> Path:
        self.assert_claim_ready()
        path = self.root / "runtime.json"
        if path.is_symlink() or path.read_text() != self._descriptor_text():
            raise ProfileError("UPDATE_SIGNATURE_INVALID")
        return path

    def _descriptor_text(self) -> str:
        value = {
            "status": self.profile.status,
            "model": str(self.model),
            "provider": self.profile.provider,
            "options": self.profile.options,
            "maxDurationSeconds": self.profile.max_duration_seconds,
            "maxRamBytes": self.profile.max_ram_bytes,
        }
        return json.dumps(value, sort_keys=True)

    def fingerprint(self, separator: Path) -> dict:
        return {
            "profile": asdict(self.profile),
            "separator": digest_file(separator),
            "model": digest_file(self.model),
            "code": {
                path.name: digest_file(path)
                for path in sorted(separator.parent.glob("*.py"))
            },
            "fixture": self.profile.fixture.sha256,
            "runtimeLock": self.profile.lock_sha256,
            "provider": self.profile.provider,
            "providerOptions": self.profile.options,
            "versions": self.versions,
            "runtimeFiles": self.files_sha256,
            "runtimeInventory": self.runtime_inventory,
            "interpreter": str(self.python.relative_to(self.root)),
            "ffmpeg": digest_file(self.ffmpeg),
            "ffprobe": digest_file(self.ffprobe) if self.ffprobe else None,
            "mediaSeconds": self.profile.max_duration_seconds,
            "reference": self.profile.reference.sha256
            if self.profile.reference
            else None,
        }


def runtime_inventory(root: Path) -> dict:
    """Bind every immutable entry, including bytecode and interpreter aliases.

    Only work/ contents are mutable; isolated, no-bytecode interpreter launches
    never import that directory. Links into it are forbidden even when contained.
    """
    result = {}
    try:
        if root.is_symlink() or root != root.resolve(strict=True):
            raise ProfileError()

        def visit(directory):
            for path in sorted(directory.iterdir()):
                name = str(path.relative_to(root))
                mode = path.lstat().st_mode
                if stat.S_ISLNK(mode):
                    target = path.resolve(strict=True)
                    relative = target.relative_to(root)
                    if relative.parts[0] == "work" or not target.is_file():
                        raise ProfileError()
                    result[name] = ["link", os.readlink(path), str(relative)]
                elif stat.S_ISDIR(mode):
                    result[name] = ["directory", stat.S_IMODE(mode)]
                    if name != "work":
                        visit(path)
                elif stat.S_ISREG(mode):
                    result[name] = [
                        "file",
                        stat.S_IMODE(mode),
                        path.stat().st_size,
                        digest_file(path),
                    ]
                else:
                    raise ProfileError()

        visit(root)
        if result.get("work", [None])[0] != "directory":
            raise ProfileError()
        return result
    except (OSError, ValueError, RuntimeError) as error:
        raise ProfileError() from error


def extract_python(archive: Path, destination: Path) -> Path:
    """Extract known standalone layout; validate every member before any write.

    Relative aliases are resolved against the archive table and materialized as
    regular files. No archive symlink is ever created on the filesystem.
    """
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        by_name = {item.name: item for item in members}
        if (
            len(by_name) != len(members)
            or len(members) > 30000
            or sum(item.size for item in members) > 1024**3
        ):
            raise ProfileError()
        for item in members:
            path = Path(item.name)
            if (
                path.is_absolute()
                or ".." in path.parts
                or not path.parts
                or path.parts[0] != "python"
                or not (item.isfile() or item.isdir() or item.issym())
            ):
                raise ProfileError()
        sources = {}
        expanded_bytes = 0
        for item in members:
            for ancestor in Path(item.name).parents:
                if str(ancestor) in by_name and not by_name[str(ancestor)].isdir():
                    raise ProfileError()
            if item.isdir():
                continue
            source = item
            seen = set()
            while source.issym():
                if source.name in seen or Path(source.linkname).is_absolute():
                    raise ProfileError()
                seen.add(source.name)
                target = os.path.normpath(
                    str(Path(source.name).parent / source.linkname)
                )
                if target not in by_name or not target.startswith("python/"):
                    raise ProfileError()
                source = by_name[target]
            if not source.isfile():
                raise ProfileError()
            expanded_bytes += source.size
            if expanded_bytes > 1024**3:
                raise ProfileError()
            sources[item.name] = source
        if (destination / "python").exists() or (destination / "python").is_symlink():
            raise ProfileError()
        for item in members:
            path = destination / item.name
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if item.isdir():
                path.mkdir(exist_ok=True, mode=0o700)
                continue
            source = sources[item.name]
            with path.open("xb") as output, bundle.extractfile(source) as stream:
                shutil.copyfileobj(stream, output)
            path.chmod(0o700 if source.mode & 0o111 else 0o600)
    return destination / "python" / "bin" / "python3.12"


def prepare_runtime(
    profile: Profile, lock_path: Path, root: Path, cache: Path
) -> PreparedRuntime:
    """Expose only shared safe setup codes; never publish native/pip tracebacks."""
    try:
        return _prepare_runtime(profile, lock_path, root, cache)
    except ProfileError:
        raise
    except (
        OSError,
        ValueError,
        TypeError,
        KeyError,
        subprocess.SubprocessError,
        tarfile.TarError,
        zipfile.BadZipFile,
    ):
        raise ProfileError("DEPENDENCY_RECIPE_UNAVAILABLE") from None


def _prepare_runtime(
    profile: Profile, lock_path: Path, root: Path, cache: Path
) -> PreparedRuntime:
    """Install wheel-only into a private venv using an authenticated native Python.

    Every archive/wheel and extracted executable is digest-bound. No shell,
    package index, source build or system Python mutation is permitted.
    """
    if (
        lock_path.is_symlink()
        or lock_path.stat().st_size > 262144
        or digest_file(lock_path) != profile.lock_sha256
    ):
        raise ProfileError("UPDATE_SIGNATURE_INVALID")
    lock = json.loads(lock_path.read_text())
    if set(lock) != {
        "pythonVersion",
        "pythonSha256",
        "pythonArchive",
        "wheels",
        "ffmpeg",
        "ffprobe",
        "versions",
    }:
        raise ProfileError()
    sha256_string(lock["pythonSha256"])
    if (
        not root.is_absolute()
        or root != root.resolve()
        or root.exists()
        or not cache.is_absolute()
        or cache != cache.resolve()
    ):
        raise ProfileError()
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    python = extract_python(fetch_asset(Asset(**lock["pythonArchive"]), cache), root)
    if digest_file(python) != lock["pythonSha256"]:
        raise ProfileError()
    version = subprocess.run(
        [str(python), "-I", "-c", "import platform; print(platform.python_version())"],
        capture_output=True,
        text=True,
        timeout=15,
        check=True,
    ).stdout.strip()
    if version != lock["pythonVersion"]:
        raise ProfileError()
    wheels = [Asset(**item) for item in lock["wheels"]]
    if not 1 <= len(wheels) <= 64 or any(
        not asset.filename.endswith(".whl") for asset in wheels
    ):
        raise ProfileError()
    ort_names = [name for name in lock["versions"] if name.startswith("onnxruntime")]
    if ort_names != [PROVIDERS[profile.provider][0]]:
        raise ProfileError()
    if any(
        not isinstance(name, str)
        or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", name)
        or not isinstance(version, str)
        or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", version)
        for name, version in lock["versions"].items()
    ):
        raise ProfileError()
    wheelhouse = root / "wheels"
    wheelhouse.mkdir(mode=0o700)
    for asset in wheels:
        shutil.copyfile(fetch_asset(asset, cache), wheelhouse / asset.filename)
    env = {
        key: value
        for key, value in os.environ.items()
        if key in ("PATH", "SYSTEMROOT", "WINDIR", "HOME", "TMPDIR", "TEMP", "TMP")
    }
    env["PYTHONNOUSERSITE"] = "1"
    subprocess.run(
        [str(python), "-I", "-m", "venv", str(root / "venv")],
        env=env,
        check=True,
        timeout=120,
        capture_output=True,
    )
    executable = (
        root / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    )
    requirements = root / "requirements.txt"
    requirements.write_text(
        "\n".join(
            f"{name}=={version}" for name, version in sorted(lock["versions"].items())
        )
        + "\n"
    )
    subprocess.run(
        [
            str(executable),
            "-I",
            "-m",
            "pip",
            "install",
            "--no-index",
            "--only-binary=:all:",
            "--find-links",
            str(wheelhouse),
            "-r",
            str(requirements),
        ],
        env=env,
        check=True,
        timeout=300,
        capture_output=True,
    )
    subprocess.run(
        [str(executable), "-I", "-m", "pip", "check"],
        env=env,
        check=True,
        timeout=30,
        capture_output=True,
    )
    measured = json.loads(
        subprocess.run(
            [
                str(executable),
                "-I",
                "-c",
                "import importlib.metadata as m,json;print(json.dumps({d.metadata['Name'].lower().replace('_','-'):d.version for d in m.distributions()}))",
            ],
            env=env,
            check=True,
            timeout=30,
            capture_output=True,
            text=True,
        ).stdout
    )
    if measured != lock["versions"]:
        raise ProfileError()
    binaries = {}
    for name in ("ffmpeg", "ffprobe"):
        info = lock[name]
        if set(info) != {"archive", "member", "sha256", "bytes"}:
            raise ProfileError()
        archive = fetch_asset(Asset(**info["archive"]), cache)
        binary = root / (name + (".exe" if profile.os == "windows" else ""))
        with tarfile.open(archive, "r:xz") as bundle:
            members = bundle.getmembers()
            if len(members) > 32 or any(not item.isfile() for item in members):
                raise ProfileError()
            member = bundle.getmember(info["member"])
            if member.size != info["bytes"] or not 0 < member.size <= 256 * 1024**2:
                raise ProfileError()
            with bundle.extractfile(member) as source, binary.open("xb") as target:
                shutil.copyfileobj(source, target)
        if digest_file(binary) != info["sha256"]:
            raise ProfileError()
        binary.chmod(0o700)
        binaries[name] = binary
    model = fetch_asset(profile.model, cache)
    (root / "work").mkdir(mode=0o700)
    runtime = PreparedRuntime(
        executable,
        profile,
        model,
        binaries["ffmpeg"],
        root,
        dict(lock["versions"]),
        ffprobe=binaries["ffprobe"],
    )
    (root / "runtime.json").write_text(runtime._descriptor_text())
    from dataclasses import replace

    inventory = runtime_inventory(root)
    return replace(
        runtime,
        runtime_inventory=inventory,
        files_sha256={
            name: value[3] for name, value in inventory.items() if value[0] == "file"
        },
    )
