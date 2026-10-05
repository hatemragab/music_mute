"""Private per-user lock and bounded lifetime for an exec'd native host."""

import fcntl
import json
import os
from pathlib import Path
import runpy
import select
import signal
import stat
import struct
import sys
import time


def fail(code):
    """Only native-v1 frames may reach Chrome; never expose an OS error/path."""
    message = json.dumps({
        "protocol_version": 1,
        "request_id": "00000000-0000-4000-8000-000000000000",
        "type": "ERROR",
        "payload": {"error_code": code},
    }, separators=(",", ":")).encode()
    try:
        sys.stdout.buffer.write(struct.pack("<I", len(message)) + message)
        sys.stdout.buffer.flush()
    except OSError:
        pass
    return 1


def private_root(path):
    """Walk through directory descriptors, refusing symlinks before any write."""
    if not path.is_absolute() or ".." in path.parts or path == Path("/"):
        raise ValueError("unsafe root")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            except FileNotFoundError:
                os.mkdir(part, mode=0o700, dir_fd=descriptor)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            info = os.fstat(child)
            if info.st_uid not in (0, os.getuid()):
                os.close(child)
                raise ValueError("unsafe ancestor")
            os.close(descriptor)
            descriptor = child
        info = os.fstat(descriptor)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("unsafe root")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def acquire_lock(root):
    root_descriptor = private_root(root)
    descriptor = None
    try:
        descriptor = os.open("host.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=root_descriptor)
        info = os.fstat(descriptor)
        entry = os.stat("host.lock", dir_fd=root_descriptor, follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600
                or (info.st_dev, info.st_ino) != (entry.st_dev, entry.st_ino)):
            raise ValueError("unsafe lock")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return descriptor
    except BaseException:
        if descriptor is not None:
            os.close(descriptor)
        raise
    finally:
        os.close(root_descriptor)


def parent_exists(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def observe_lifetime(host_pid, original_parent, lock_descriptor):
    """Observe input closure without reading bytes or retaining host output/lock."""
    try:
        os.close(lock_descriptor)
        for descriptor in (1, 2):
            try:
                os.close(descriptor)
            except OSError:
                pass
        # macOS poll does not report a pipe's HUP with an empty event mask.
        # kqueue reports EOF independently of consuming any readable bytes.
        if hasattr(select, "kqueue"):
            observer = select.kqueue()
            observer.control([select.kevent(0, filter=select.KQ_FILTER_READ, flags=select.KQ_EV_ADD)], 0)
        else:
            observer = select.poll()
            observer.register(0, select.POLLIN)
        deadline = None
        term_sent = False
        while os.getppid() == host_pid:
            if hasattr(select, "kqueue"):
                disconnected = any(event.flags & select.KQ_EV_EOF for event in observer.control(None, 1, 0))
            else:
                disconnected = any(flags & (select.POLLHUP | select.POLLERR | select.POLLNVAL) for _, flags in observer.poll(0))
            now = time.monotonic()
            if deadline is None and (disconnected or not parent_exists(original_parent)):
                deadline = now + 0.5  # Let normal EOF shutdown drain first.
            if deadline is not None and now >= deadline:
                if os.getppid() != host_pid:
                    break
                os.kill(host_pid, signal.SIGTERM if not term_sent else signal.SIGKILL)
                if term_sent:
                    break
                term_sent = True
                deadline = now + 3
            time.sleep(0.1)  # A persistent HUP must not cause a busy loop.
    except (OSError, ValueError):
        # The host may finish between the parent check and signal.
        pass
    finally:
        os._exit(0)


def main():
    original_parent = os.getppid()
    update_descriptor = None
    try:
        component = "MusicMuteLocal" if os.environ.get("MUSICMUTE_LOCAL_APP_RESOURCES") else "MusicMuteLocalMvp"
        root = Path(os.environ.get("MUSICMUTE_LOCAL_ROOT", Path.home() / "Library/Application Support" / component))
        update_lock = runpy.run_path(str(Path(__file__).with_name("update-lock.py")))
        try:
            update_descriptor = update_lock["acquire"](root)
        except BlockingIOError:
            return fail("UPDATE_INSTALLING")
        descriptor = acquire_lock(root)
    except BlockingIOError:
        if update_descriptor is not None:
            os.close(update_descriptor)
        return fail("LOCAL_COMPANION_BUSY")
    except (OSError, ValueError):
        if update_descriptor is not None:
            os.close(update_descriptor)
        return fail("LOCAL_COMPANION_LOCK_UNSAFE")
    guardian = None
    try:
        if len(sys.argv) < 2:
            raise ValueError("missing executable")
        os.set_inheritable(descriptor, True)
        host_pid = os.getpid()
        guardian = os.fork()
        if guardian == 0:
            observe_lifetime(host_pid, original_parent, descriptor)
        os.execv(sys.argv[1], sys.argv[1:])
    except (OSError, ValueError):
        if guardian:
            try:
                os.kill(guardian, signal.SIGTERM)
                os.waitpid(guardian, 0)
            except OSError:
                pass
        return fail("LOCAL_COMPANION_START_FAILED")
    finally:
        os.close(descriptor)
        if update_descriptor is not None:
            os.close(update_descriptor)


if __name__ == "__main__":
    sys.exit(main())
