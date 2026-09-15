"""Origin-confined transfers and extraction. Bytes are never executed here."""

import hashlib
import json
import os
import re
import shutil
import stat
import struct
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from ..config import https_url
from ..runtime_types import sha256_string

MAX_ARTIFACT_BYTES = 16 * 1024**3


def relative_path(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise ValueError("Invalid artifact path")
    parsed = urlsplit(value)
    if (
        parsed.scheme
        or parsed.netloc
        or parsed.query
        or parsed.fragment
        or "%" in value
        or "\\" in value
        or ":" in value
        or any(ord(c) < 33 or ord(c) > 126 for c in value)
        or value.startswith("/")
        or any(p in ("", ".", "..") for p in value.split("/"))
    ):
        raise ValueError("Invalid artifact path")
    return value


class DistributionOrigin:
    def __init__(self, origin: str):
        https_url(origin)
        parsed = urlsplit(origin)
        if (
            parsed.path not in ("", "/")
            or parsed.query
            or parsed.port not in (None, 443)
        ):
            raise ValueError("Distribution must be an HTTPS origin")
        self.origin = "https://" + parsed.netloc.lower().rstrip("/")

    def url(self, path: str) -> str:
        return self.origin + "/" + relative_path(path)

    def check(self, url: str) -> None:
        if not url.startswith(self.origin + "/"):
            raise ValueError("Distribution origin mismatch")
        self.url(url[len(self.origin) + 1 :])


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Distribution redirect refused")


def open_https(url: str, headers: dict):
    # Explicitly disable environment proxy discovery and all redirects. TLS uses
    # the system trust store; no credential is sent to the distribution service.
    return build_opener(ProxyHandler({}), _NoRedirect()).open(
        Request(url, headers=headers), timeout=30
    )


def private_directory(path: Path) -> None:
    if not path.is_absolute():
        raise ValueError("Absolute private cache path required")
    for parent in (*reversed(path.parents), path):
        if parent.is_symlink():
            raise ValueError("Cache must not contain symlinks")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)


def atomic_record(path: Path, value: dict) -> None:
    if path.is_symlink():
        raise ValueError("Cache record is a symlink")
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".record-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, separators=(",", ":"), allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        if os.name != "nt":
            fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def verify_bytes(path: Path, length: int, digest: str) -> None:
    sha256_string(digest)
    if type(length) is not int or not 0 < length <= MAX_ARTIFACT_BYTES:
        raise ValueError("Invalid artifact length")
    if path.is_symlink() or not path.is_file() or path.stat().st_size != length:
        raise ValueError("Artifact length mismatch")
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    if h.hexdigest() != digest:
        raise ValueError("Artifact digest mismatch")


class ArtifactDownloader:
    """Caller holds the installation machine lock across cache mutation."""

    def __init__(self, origin: DistributionOrigin, *, transport=open_https):
        self.origin = origin
        self.transport = transport

    def download(
        self, target: dict, cache: Path, *, reserve_bytes=256 * 1024**2
    ) -> Path:
        private_directory(cache)
        digest = sha256_string(target["artifactSha256"])
        length = target["artifactBytes"]
        if type(length) is not int or not 0 < length <= MAX_ARTIFACT_BYTES:
            raise ValueError("Invalid artifact length")
        url = self.origin.url(target["artifactPath"].removeprefix("/"))
        final = cache / digest
        partial, record = cache / (digest + ".part"), cache / (digest + ".json")
        for path in (final, partial, record):
            if path.is_symlink():
                raise ValueError("Artifact cache symlink")
        if final.exists():
            verify_bytes(final, length, digest)
            return final
        if shutil.disk_usage(cache).free < length + reserve_bytes:
            raise OSError("INSUFFICIENT_DISK")
        offset, etag = 0, None
        if partial.exists() and record.exists() and record.stat().st_size <= 4096:
            try:
                saved = json.loads(record.read_text())
                if (
                    saved["url"] == url
                    and saved["length"] == length
                    and saved["digest"] == digest
                ):
                    etag = saved["etag"]
                    if isinstance(etag, str) and re.fullmatch(
                        r'"[\x21\x23-\x7e]{1,512}"', etag
                    ):
                        offset = partial.stat().st_size
            except (ValueError, KeyError, TypeError):
                pass
        if offset >= length:
            try:
                verify_bytes(partial, length, digest)
                os.replace(partial, final)
                record.unlink(missing_ok=True)
                return final
            except ValueError:
                offset = 0
        headers = {"Accept-Encoding": "identity"}
        if offset:
            headers.update({"Range": f"bytes={offset}-", "If-Range": etag})
        deadline = time.monotonic() + 1800
        try:
            response = self.transport(url, headers)
        except HTTPError as error:
            if offset and error.code == 416:
                error.close()
                partial.unlink(missing_ok=True)
                record.unlink(missing_ok=True)
                return self.download(target, cache, reserve_bytes=reserve_bytes)
            raise
        with response:
            status = response.status
            received_etag = response.headers.get("ETag")
            if response.headers.get("Content-Encoding", "identity") != "identity":
                raise ValueError("Encoded artifact refused")
            if status == 206:
                expected = f"bytes {offset}-{length - 1}/{length}"
                if (
                    not offset
                    or response.headers.get("Content-Range") != expected
                    or received_etag != etag
                ):
                    partial.unlink(missing_ok=True)
                    record.unlink(missing_ok=True)
                    raise ValueError("Invalid resumed content identity")
            elif status == 200:
                offset = 0
            else:
                raise ValueError("Unexpected artifact response")
            content_length = response.headers.get("Content-Length")
            if content_length is not None and content_length != str(length - offset):
                raise ValueError("Artifact response length mismatch")
            atomic_record(
                record,
                {"url": url, "length": length, "digest": digest, "etag": received_etag},
            )
            with partial.open("ab" if offset else "wb") as output:
                size = offset
                try:
                    while block := response.read(min(1024 * 1024, length - size + 1)):
                        if time.monotonic() > deadline:
                            raise TimeoutError("Artifact transfer deadline exceeded")
                        size += len(block)
                        if size > length:
                            raise ValueError("Artifact exceeds signed length")
                        output.write(block)
                finally:
                    output.flush()
                    os.fsync(output.fileno())
        verify_bytes(partial, length, digest)
        os.replace(partial, final)
        record.unlink(missing_ok=True)
        return final


def open_bundle(archive: Path) -> zipfile.ZipFile:
    """Bound the ZIP central directory before ZipFile allocates its inventory."""
    if archive.is_symlink() or not archive.is_file():
        raise ValueError("Invalid bundle file")
    length = archive.stat().st_size
    with archive.open("rb") as source:
        source.seek(max(0, length - 65557))
        tail = source.read(65557)
        index = tail.rfind(b"PK\x05\x06")
        if index < 0 or len(tail) - index < 22:
            raise ValueError("Unsupported bundle format; ZIP required")
        signature, disk, directory_disk, disk_count, count, size, offset, comment = (
            struct.unpack("<4s4H2LH", tail[index : index + 22])
        )
        end_offset = length - len(tail) + index
        if (
            disk
            or directory_disk
            or disk_count != count
            or index + 22 + comment != len(tail)
        ):
            raise ValueError("Unsupported split or malformed ZIP")
        if count == 65535 or size == 0xFFFFFFFF or offset == 0xFFFFFFFF:
            if end_offset < 20:
                raise ValueError("Invalid ZIP64 locator")
            source.seek(end_offset - 20)
            locator, locator_disk, record_offset, disks = struct.unpack(
                "<4sLQL", source.read(20)
            )
            if (
                locator != b"PK\x06\x07"
                or locator_disk
                or disks != 1
                or record_offset + 56 > end_offset - 20
            ):
                raise ValueError("Unsupported ZIP64 layout")
            source.seek(record_offset)
            record = source.read(56)
            (
                signature,
                record_size,
                _made,
                _needed,
                disk,
                directory_disk,
                disk_count,
                count,
                size,
                offset,
            ) = struct.unpack("<4sQ2H2L4Q", record)
            if (
                signature != b"PK\x06\x06"
                or not 44 <= record_size <= 1024
                or disk
                or directory_disk
                or disk_count != count
            ):
                raise ValueError("Unsupported ZIP64 directory")
        if (
            not 1 <= count <= 100_000
            or size > 16 * 1024**2
            or offset + size > end_offset
        ):
            raise ValueError("Bundle inventory exceeds policy ceiling")
    return zipfile.ZipFile(archive)


def extract_bundle(
    archive: Path,
    destination: Path,
    expected_files: set[str],
    *,
    max_unpacked_bytes: int,
    reserve_bytes: int = 256 * 1024**2,
) -> None:
    """Extract a verified ZIP to a new stage, using its signed file inventory.

    Existing active/staged environments are never replaced. The caller supplies
    a signed bounded inventory and holds the installation machine lock.
    """
    if destination.exists() or destination.is_symlink():
        raise ValueError("Stage already exists")
    private_directory(destination.parent)
    if (
        type(max_unpacked_bytes) is not int
        or not 0 < max_unpacked_bytes <= 32 * 1024**3
    ):
        raise ValueError("Invalid extraction ceiling")
    expected = {relative_path(p) for p in expected_files}
    if not expected or len(expected) > 100_000:
        raise ValueError("Invalid signed file inventory")
    with open_bundle(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) > 100_000:
            raise ValueError("Too many bundle entries")
        seen, total = set(), 0
        for item in entries:
            name = relative_path(
                item.filename.rstrip("/") if item.is_dir() else item.filename
            )
            mode = item.external_attr >> 16
            if (
                stat.S_ISLNK(mode)
                or mode & 0o7000
                or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))
                or item.flag_bits & 1
            ):
                raise ValueError("Unsupported bundle member")
            # Casefold and Windows names are rejected on every OS for one portable artifact rule.
            for part in PurePosixPath(name).parts:
                if part.endswith((".", " ")) or re.fullmatch(
                    r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part
                ):
                    raise ValueError("Nonportable bundle member")
            key = name.casefold()
            if key in seen:
                raise ValueError("Duplicate bundle member")
            seen.add(key)
            if not item.is_dir() and name not in expected:
                raise ValueError("Unexpected bundle member")
            if item.is_dir() and not any(p.startswith(name + "/") for p in expected):
                raise ValueError("Unexpected bundle directory")
            total += item.file_size
            if total > max_unpacked_bytes:
                raise ValueError("Bundle expands beyond ceiling")
        file_keys = {i.filename.casefold() for i in entries if not i.is_dir()}
        for name in seen:
            if any(
                str(parent) in file_keys
                for parent in PurePosixPath(name).parents
                if str(parent) != "."
            ):
                raise ValueError("Bundle member ancestor conflict")
        if {i.filename for i in entries if not i.is_dir()} != expected:
            raise ValueError("Missing bundle member")
        if shutil.disk_usage(destination.parent).free < total + reserve_bytes:
            raise OSError("INSUFFICIENT_DISK")
        stage = Path(tempfile.mkdtemp(prefix=".extract-", dir=destination.parent))
        try:
            actual = 0
            for item in entries:
                path = stage / item.filename
                if item.is_dir():
                    path.mkdir(parents=True, exist_ok=True)
                    continue
                path.parent.mkdir(parents=True, exist_ok=True)
                count = 0
                with bundle.open(item) as source, path.open("xb") as output:
                    while block := source.read(1024 * 1024):
                        count += len(block)
                        actual += len(block)
                        if count > item.file_size or actual > max_unpacked_bytes:
                            raise ValueError("Decompression overflow")
                        output.write(block)
                    output.flush()
                    os.fsync(output.fileno())
                if count != item.file_size:
                    raise ValueError("Bundle member length mismatch")
                path.chmod(0o700 if (item.external_attr >> 16) & 0o111 else 0o600)
            os.replace(stage, destination)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
