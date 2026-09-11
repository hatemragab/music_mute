"""Build a portable source-only Windows handoff, excluding local configuration."""

import argparse
import hashlib
import zipfile
from pathlib import Path


def build(destination: Path) -> Path:
    root = Path(__file__).resolve().parent
    files = [
        root / name
        for name in (
            "README.md",
            "Configure-Worker.ps1",
            "Start-Worker.ps1",
            "Install-Autostart.ps1",
            "Benchmark-Worker.ps1",
            "worker.config.example.json",
        )
    ]
    files += sorted((root / "musicmute_worker").glob("*.py"))
    files += [
        root / "tests" / name
        for name in (
            "test_processes.py",
            "test_transport.py",
            "test_worker.py",
            "test_power.py",
            "test_autostart.py",
            "test_progress.py",
            "test_reliability.py",
            "test_loop.py",
            "test_engine.py",
            "test_separator.py",
            "test_warm_worker.py",
            "test_benchmark.py",
            "process_test_support.py",
        )
    ]
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            if path.is_symlink():
                raise ValueError("Package source must not be a symlink")
            archive.write(
                path, "MusicMuteWindowsWorker/" + path.relative_to(root).as_posix()
            )
        archive.write(
            root.parent / "backend" / "separate.py",
            "MusicMuteWindowsWorker/separate.py",
        )
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent / "dist" / "MusicMuteWindowsWorker.zip",
    )
    args = parser.parse_args()
    result = build(args.output)
    print(result)
    print("SHA256: " + hashlib.sha256(result.read_bytes()).hexdigest())
