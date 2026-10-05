"""Build and byte-verify an allowlisted, credential-free yt-dlp archive."""
import argparse
import io
import os
from pathlib import Path
import tarfile
import tempfile

FILES = ('captain-definition', 'Dockerfile', '.dockerignore', 'requirements.txt',
         'service.py', 'acquirer.py', 'extract.py', 'diagnostics.py', 'proxy_sessions.py', 'bootstrap.py', 'patch_provider.py',
         'source_policy.py', 'acquisition_context.py', 'acquisition_limits.py',
         'acquisition_metadata.py', 'acquisition_scratch.py')
SHARED = ('acquisition_context.py', 'acquisition_limits.py',
          'acquisition_metadata.py', 'acquisition_scratch.py')


def source_path(name):
    root = Path(__file__).resolve().parent
    if name in SHARED:
        return root.parent / name
    if name == 'source_policy.py':
        return root.parent / 'router' / name
    return root / name


def package(output):
    output = Path(output).resolve()
    root = Path(__file__).resolve().parents[2]
    if output.is_relative_to(root):
        raise ValueError('Deployment archive must be outside the source tree')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, prefix='.ytdlp-package-', delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with tarfile.open(temporary, 'w', format=tarfile.USTAR_FORMAT) as archive:
            for name in FILES:
                source = source_path(name)
                if source.is_symlink() or not source.is_file():
                    raise ValueError('Deployment inputs must be ordinary files')
                data = source.read_bytes()
                info = tarfile.TarInfo(name)
                info.size, info.mode = len(data), 0o644
                archive.addfile(info, io.BytesIO(data))
        with tarfile.open(temporary, 'r') as archive:
            entries = archive.getmembers()
            if tuple(entry.name for entry in entries) != FILES or not all(entry.isfile() for entry in entries):
                raise ValueError('Unexpected deployment archive entry')
            for entry in entries:
                if archive.extractfile(entry).read() != source_path(entry.name).read_bytes():
                    raise ValueError('Deployment archive byte mismatch')
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', help='Absolute archive path outside the source tree')
    print(package(parser.parse_args().output))
