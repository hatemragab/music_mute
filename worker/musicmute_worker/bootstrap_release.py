"""Local bootstrap release descriptor: the v1 install source.

In v1 the native entrypoint downloads one operator-published tarball, verifies it
against the recipe digest, and extracts it as `releases/bootstrap-<sha256>/`.
That verified stage *is* the release: it carries the private interpreter, the
shared worker source, the profile/lock recipes and this descriptor. Integrity is
checked by hash exactly as the light distribution model specifies — there is no
online trust ceremony, so nothing here may be treated as a backend attestation.

The descriptor is the same `ReleaseTarget` shape the signed path uses, so the
qualification and readiness checks downstream stay unchanged. What differs is
provenance: `bootstrap_stage` records which verified stage supplied it, and the
stage inventory is re-checked before any descriptor is trusted.
"""

import hashlib
import json
import re
from pathlib import Path

from .profiles import ProfileError

DESCRIPTOR_NAME = "release.json"
INVENTORY_NAME = ".bootstrap-sha256"
MAX_DESCRIPTOR_BYTES = 65536

_BSD = re.compile(r"^SHA256 \((.+)\) = ([0-9a-f]{64})$")
_GNU = re.compile(r"^([0-9a-f]{64}) [ *](.+)$")


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_inventory(text):
    """Accept both `shasum -a 256` and `sha256sum` output; nothing else."""
    entries = {}
    for line in text.splitlines():
        if not line:
            continue
        match = _BSD.fullmatch(line) or _GNU.fullmatch(line)
        if match is None:
            raise ProfileError("UPDATE_SIGNATURE_INVALID")
        bsd = _BSD.fullmatch(line) is not None
        name, expected = (
            (match.group(1), match.group(2))
            if bsd
            else (
                match.group(2),
                match.group(1),
            )
        )
        name = name.removeprefix("./")
        if (
            not name
            or name.startswith("/")
            or name == INVENTORY_NAME
            or any(part in ("", ".", "..") for part in name.split("/"))
            or name in entries
        ):
            raise ProfileError("UPDATE_SIGNATURE_INVALID")
        entries[name] = expected
    if not entries:
        raise ProfileError("UPDATE_SIGNATURE_INVALID")
    return entries


def verify_stage(stage: Path):
    """Re-authenticate the whole stage before any descriptor inside it is read.

    The entrypoint verified this tree at download time; a service may start much
    later, so the cached tree is checked again rather than assumed intact.
    """
    if (
        not stage.is_absolute()
        or stage != stage.resolve()
        or stage.is_symlink()
        or not stage.is_dir()
        or not re.fullmatch(r"bootstrap-[a-f0-9]{64}", stage.name)
    ):
        raise ProfileError("UPDATE_SIGNATURE_INVALID")
    inventory_path = stage / INVENTORY_NAME
    if inventory_path.is_symlink() or not inventory_path.is_file():
        raise ProfileError("UPDATE_SIGNATURE_INVALID")
    expected = parse_inventory(
        inventory_path.read_text(encoding="utf-8", errors="strict")
    )
    found = {}
    for path in stage.rglob("*"):
        if path.is_symlink():
            raise ProfileError("UPDATE_SIGNATURE_INVALID")
        if path.is_file() and path != inventory_path:
            found[path.relative_to(stage).as_posix()] = path
    if set(found) != set(expected):
        raise ProfileError("UPDATE_SIGNATURE_INVALID")
    for name, expected_digest in sorted(expected.items()):
        if digest_file(found[name]) != expected_digest:
            raise ProfileError("UPDATE_SIGNATURE_INVALID")
    return expected


def stage_artifact_digest(inventory):
    """Identity of the staged payload, excluding the descriptor and its own list.

    This is derived from the bytes present, never taken from the descriptor, so a
    rewritten descriptor cannot restate its own release identity.
    """
    payload = {
        name: digest for name, digest in inventory.items() if name != DESCRIPTOR_NAME
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def load_descriptor(stage: Path):
    """Return (descriptor, payload_digest) from a fully re-verified stage.

    Scope of the check: `verify_stage` detects corruption, truncation and partial
    writes against the entrypoint's recorded inventory. It is **not** a signature.
    Anyone able to write inside the protected root can rewrite the inventory too,
    so the real protections remain the recipe digest checked at download time and
    the root-owned 0700 stage. The backend never treats this stage as attestation.
    """
    inventory = verify_stage(stage)
    path = stage / DESCRIPTOR_NAME
    if (
        path.is_symlink()
        or not path.is_file()
        or path.stat().st_size > MAX_DESCRIPTOR_BYTES
        or DESCRIPTOR_NAME not in inventory
    ):
        raise ProfileError("DEPENDENCY_RECIPE_UNAVAILABLE")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ProfileError("DEPENDENCY_RECIPE_UNAVAILABLE")
    payload = stage_artifact_digest(inventory)
    declared = value.get("artifactSha256")
    if declared is not None and declared != payload:
        raise ProfileError("UPDATE_SIGNATURE_INVALID")
    value["artifactSha256"] = payload
    return value, payload
