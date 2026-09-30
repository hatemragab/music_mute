"""Create an allowlisted, credential-free deployment archive."""
import argparse
import pathlib
import tarfile

FILES = ('captain-definition', 'Dockerfile', '.dockerignore', 'service.py', 'source_policy.py')


def package(output):
    root = pathlib.Path(__file__).resolve().parent
    output = pathlib.Path(output).resolve()
    with tarfile.open(output, 'w') as archive:
        for name in FILES:
            path = root / name
            if not path.is_file() or path.is_symlink():
                raise ValueError('Missing regular package source')
            archive.add(path, arcname=name, recursive=False)
    with tarfile.open(output) as archive:
        if tuple(archive.getnames()) != FILES:
            raise ValueError('Unexpected archive content')
        for name in FILES:
            if archive.extractfile(name).read() != (root / name).read_bytes():
                raise ValueError('Package content differs from source')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('output', help='Absolute deployment archive path outside source')
    package(parser.parse_args().output)
