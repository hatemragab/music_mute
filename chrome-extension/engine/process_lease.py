"""Preserve the owned update lease through Python engine/tool descendants."""
import os
from pathlib import Path
import stat
import subprocess


def propagate_update_lease():
    raw = os.environ.get("MUSICMUTE_UPDATE_LEASE_FD")
    if raw is None:
        return ()
    try:
        if not raw.isdecimal() or len(raw) > 8:
            raise ValueError()
        descriptor = int(raw)
        if descriptor < 3:
            raise ValueError()
        info = os.fstat(descriptor)
        root = os.environ["MUSICMUTE_LOCAL_ROOT"]
        path = Path(root)
        if not path.is_absolute() or ".." in path.parts or path.is_symlink():
            raise ValueError()
        named = os.lstat(path / "update.lock")
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
            raise ValueError()
    except (OSError, KeyError, ValueError):
        raise ValueError("LOCAL_UPDATE_LEASE_INVALID") from None
    original = subprocess.Popen.__init__
    if not getattr(original, "_musicmute_update_lease", False):
        def initialize(self, *args, **kwargs):
            inherited = tuple(kwargs.get("pass_fds", ()))
            kwargs["pass_fds"] = tuple(dict.fromkeys((*inherited, descriptor)))
            kwargs["close_fds"] = True
            return original(self, *args, **kwargs)
        initialize._musicmute_update_lease = True
        subprocess.Popen.__init__ = initialize
    return (descriptor,)
