"""Build a source-only shared worker archive, never an installer or qualified release."""

import argparse
import hashlib
import zipfile
from pathlib import Path


def build(destination: Path) -> Path:
    root = Path(__file__).resolve().parent
    files = [
        root / "README.md",
        root / "pyproject.toml",
        root / "package.py",
        root / "install" / "install.sh",
        root / "install" / "install.ps1",
        root / "docs" / "install.md",
        root / "docs" / "macos.md",
        root / "contracts" / "worker-protocol-v3.json",
        root / "qualification" / "candidates.json",
        root / "qualification" / "THIRD_PARTY_NOTICES.md",
        root / "profiles" / "README.md",
        root / "profiles" / "macos-arm64-coreml.candidate.json",
        root / "profiles" / "macos-arm64-coreml.lock.json",
        root / "launcher-locks" / "README.md",
        root / "launcher-locks" / "macos-arm64-py312.lock.json",
        root / "launcher-locks" / "macos-arm64-py312.txt",
        root / "launcher-locks" / "windows-x64-py312.lock.json",
        root / "launcher-locks" / "windows-x64-py312.txt",
        root / "launcher-locks" / "linux-x64-py312.lock.json",
        root / "launcher-locks" / "linux-x64-py312.txt",
    ]
    for folder in ("musicmute_worker", "tests", "qualification"):
        files.extend(sorted((root / folder).rglob("*.py")))
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            if path.is_symlink():
                raise ValueError("Package source must not be a symlink")
            archive.write(path, "worker/" + path.relative_to(root).as_posix())
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    result = build(parser.parse_args().output)
    print(result)
    print("SHA256: " + hashlib.sha256(result.read_bytes()).hexdigest())
