"""No-network process leases fence native helpers while Sparkle replaces the app."""
import fcntl
import os
from pathlib import Path
import stat
import subprocess
import sys
import time


def acquire(root, exclusive=False):
    path = Path(root)
    if not path.is_absolute() or ".." in path.parts or path == Path("/"):
        raise ValueError("unsafe root")
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    descriptor = None
    try:
        for part in path.parts[1:]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            except FileNotFoundError:
                os.mkdir(part, mode=0o700, dir_fd=directory)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            info = os.fstat(child)
            if info.st_uid not in (0, os.getuid()):
                os.close(child)
                raise ValueError("unsafe ancestor")
            os.close(directory)
            directory = child
        info = os.fstat(directory)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("unsafe root")
        descriptor = os.open("update.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
        info = os.fstat(descriptor)
        named = os.stat("update.lock", dir_fd=directory, follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
            raise ValueError("unsafe lock")
        fcntl.flock(descriptor, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        os.set_inheritable(descriptor, True)
        return descriptor
    except BaseException:
        if descriptor is not None:
            os.close(descriptor)
        raise
    finally:
        os.close(directory)


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--run":
        component = "MusicMuteLocal" if os.environ.get("MUSICMUTE_LOCAL_APP_RESOURCES") else "MusicMuteLocalMvp"
        root = os.environ.get("MUSICMUTE_LOCAL_ROOT", str(Path.home() / "Library/Application Support" / component))
        try:
            descriptor = acquire(root)
        except BlockingIOError:
            return 75
        except (OSError, ValueError):
            return 76
        try:
            os.environ["MUSICMUTE_UPDATE_LEASE_FD"] = str(descriptor)
            os.execv(sys.argv[2], sys.argv[2:])
        finally:
            os.close(descriptor)
    if len(sys.argv) == 6 and sys.argv[1] == "--guard":
        # stdin is the already-held exclusive lock, passed by FileHandle. Keep it
        # across app termination until Sparkle's atomic bundle replacement is visible.
        parent, bundle, device, inode = int(sys.argv[2]), sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
        print("READY", flush=True)
        os.close(1)
        absent_since = None
        while True:
            try:
                os.kill(parent, 0)
                alive = True
            except ProcessLookupError:
                alive = False
            except PermissionError:
                alive = True
            try:
                info = os.lstat(bundle)
                replaced = stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) != (device, inode)
            except OSError:
                replaced = False
            if not alive and replaced:
                return 0
            if not alive:
                # Recover only after the actual Sparkle installers have ended;
                # an elapsed deadline must not reopen a slow installation.
                try:
                    listing = subprocess.run(["/bin/ps", "-axo", "comm="], capture_output=True,
                                             text=True, check=True, timeout=2).stdout
                    active = any(Path(line.strip()).name in ("Autoupdate", "Installer", "Updater")
                                 for line in listing.splitlines())
                except (OSError, subprocess.SubprocessError):
                    active = True
                if active:
                    absent_since = None
                elif absent_since is None:
                    absent_since = time.monotonic()
                elif time.monotonic() - absent_since >= 2:
                    return 0
            time.sleep(0.1)
    return 64


if __name__ == "__main__":
    sys.exit(main())
