"""Bounded one-shot service tasks with kernel ownership of all descendants."""
from __future__ import annotations

import os
import runpy
import sys
import threading

from .windows_guardian import own_job, watch_parent

TASKS = frozenset({"musicmute_engine.qualification", "musicmute_engine.benchmark_file", "musicmute_engine.capacity_benchmark"})


def main() -> int:
    arguments = sys.argv[1:]
    if len(arguments) < 3 or arguments[0] not in TASKS or arguments[1] != "--":
        return 2
    try:
        # The service task joins before importing inference code or spawning any
        # decoder. WinSW death and explicit service stop cannot orphan its work.
        job = own_job()
        watch_parent(os.getppid())
        deadline = threading.Timer(7200, lambda: os._exit(124))
        deadline.daemon = True
        deadline.start()
        try:
            sys.argv = [arguments[0], *arguments[2:]]
            # Spawned workers resolve functions through __main__; expose the
            # executing module while it owns the process, including on Windows.
            runpy.run_module(arguments[0], run_name="__main__", alter_sys=True)
            return 0
        except SystemExit as finished:
            return finished.code if isinstance(finished.code, int) and 0 <= finished.code <= 255 else 2
        finally:
            deadline.cancel()
            assert job
    except BaseException:
        print("Windows service task failed; inspect its private report", file=sys.stderr)
        return 2


if __name__ == "__main__":
    result = main()
    sys.stdout.flush()
    sys.stderr.flush()
    # Closing the process releases its sole non-inherited Job Object handle.
    os._exit(result)
