"""Content-addressed installation and verification for the qualified Kim model."""

from __future__ import annotations

import hashlib
import os
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from typing import BinaryIO, Callable

from .recipes import MODEL_BYTES, MODEL_FILENAME, MODEL_SHA256, MODEL_SOURCE

READ_BYTES = 1024 * 1024
ALLOWED_DOWNLOAD_HOSTS = frozenset(
    {
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
        "github-releases.githubusercontent.com",
    }
)


class ModelArtifactError(RuntimeError):
    """Raised when the immutable model artifact is absent or invalid."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(READ_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def model_path(cache_root: Path) -> Path:
    return cache_root / MODEL_SHA256 / MODEL_FILENAME


def verify_model(path: Path) -> Path:
    if path.is_symlink() or not path.is_file():
        raise ModelArtifactError("Qualified Kim model is missing")
    if path.stat().st_size != MODEL_BYTES:
        raise ModelArtifactError("Qualified Kim model size does not match")
    if sha256_file(path) != MODEL_SHA256:
        raise ModelArtifactError("Qualified Kim model checksum does not match")
    return path.resolve(strict=True)


def verified_cached_model(cache_root: Path) -> Path:
    if not cache_root.is_absolute():
        raise ModelArtifactError("Model cache path must be absolute")
    return verify_model(model_path(cache_root))


def install_model_from_file(source: Path, cache_root: Path) -> Path:
    source = verify_model(source)
    with source.open("rb") as stream:
        return _install_stream(stream, cache_root)


def download_model(
    cache_root: Path,
    *,
    source_url: str = MODEL_SOURCE,
    opener: Callable[..., BinaryIO] = urllib.request.urlopen,
) -> Path:
    if source_url != MODEL_SOURCE:
        raise ModelArtifactError("Model source URL is not allowlisted")
    parsed = urllib.parse.urlparse(source_url)
    if parsed.scheme != "https" or parsed.hostname != "github.com":
        raise ModelArtifactError("Model source URL is invalid")
    response = opener(source_url, timeout=120)
    try:
        final_url = getattr(response, "geturl", lambda: source_url)()
        final = urllib.parse.urlparse(final_url)
        if final.scheme != "https" or final.hostname not in ALLOWED_DOWNLOAD_HOSTS:
            raise ModelArtifactError("Model download redirected outside GitHub")
        return _install_stream(response, cache_root)
    finally:
        response.close()


def _install_stream(source: BinaryIO, cache_root: Path) -> Path:
    if not cache_root.is_absolute():
        raise ModelArtifactError("Model cache path must be absolute")
    destination = model_path(cache_root)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        return verify_model(destination)

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{MODEL_FILENAME}.", dir=destination.parent
    )
    temporary = Path(temporary_name)
    digest = hashlib.sha256()
    written = 0
    try:
        with os.fdopen(descriptor, "wb") as target:
            while chunk := source.read(READ_BYTES):
                written += len(chunk)
                if written > MODEL_BYTES:
                    raise ModelArtifactError("Model download exceeds expected size")
                digest.update(chunk)
                target.write(chunk)
            target.flush()
            os.fsync(target.fileno())
        if written != MODEL_BYTES or digest.hexdigest() != MODEL_SHA256:
            raise ModelArtifactError("Downloaded model identity does not match")
        os.replace(temporary, destination)
        return verify_model(destination)
    finally:
        temporary.unlink(missing_ok=True)
