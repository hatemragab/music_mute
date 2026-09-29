"""Private, bounded process cohorts with a common post-warmup start barrier."""
from __future__ import annotations

import json
import math
import multiprocessing
import os
import signal
import threading
import time
from multiprocessing.connection import Connection, wait
from typing import Any, Callable


class CoordinationError(RuntimeError):
    """The process cohort could not produce complete, synchronized evidence."""


def _send(connection: Connection, kind: str, **fields: object) -> None:
    connection.send_bytes(json.dumps({"type": kind, **fields}).encode("utf-8"))


def _owned_child(
    control: Connection,
    lifetime: Connection,
    task: Callable[..., None],
    argument: Any,
) -> None:
    # Independent ownership includes FFmpeg children, even if inference hangs.
    # The lifetime pipe is separate from measurement messages, so a blocked
    # ready barrier or model call cannot prevent detection of coordinator death.
    if os.name == "nt":
        from .windows_guardian import own_job
        job = own_job()
    else:
        os.setsid()
        job = None

    def stop() -> None:
        if os.name == "nt":
            os._exit(0)  # Closes this process's non-inherited Job Object handle.
        os.killpg(os.getpgrp(), signal.SIGKILL)

    def watch() -> None:
        try:
            lifetime.recv_bytes(1)
        except (OSError, EOFError):
            pass
        finally:
            stop()

    threading.Thread(target=watch, daemon=True).start()
    try:
        def ready() -> None:
            _send(control, "ready")
            if not control.poll(7200) or control.recv_bytes(16) != b"measure":
                raise CoordinationError("Measurement start was not received")

        def measured(seconds: float) -> None:
            _send(control, "measured", seconds=seconds)

        task(argument, ready, measured)
        _send(control, "finished")
    except BaseException:
        try:
            _send(control, "failed")
        except (OSError, EOFError):
            pass
    finally:
        # Parent closes lifetime after consuming reports, or when any peer fails.
        # Remain alive so it can always terminate the entire owned subtree.
        assert job is None or job
        threading.Event().wait()


def run_cohort(
    task: Callable[..., None],
    arguments: list[Any],
    *,
    timeout_seconds: float = 7200,
) -> dict[str, object]:
    if len(arguments) not in (1, 2) or not 0 < timeout_seconds <= 7200:
        raise CoordinationError("Cohort bounds are invalid")
    context = multiprocessing.get_context("spawn")
    children = []
    channels = []
    lifetimes = []
    phases: list[str] = []
    measured: list[float | None] = [None] * len(arguments)
    started: float | None = None
    completed: float | None = None
    deadline = time.perf_counter() + timeout_seconds
    try:
        for argument in arguments:
            parent, child = context.Pipe(duplex=True)
            life_reader, life_writer = context.Pipe(duplex=False)
            process = context.Process(target=_owned_child, args=(child, life_reader, task, argument))
            channels.append(parent)
            lifetimes.append(life_writer)
            try:
                process.start()
                children.append(process)
                phases.append("loading")
            finally:
                child.close()
                life_reader.close()
        while any(phase != "finished" for phase in phases):
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                raise CoordinationError("Cohort deadline exceeded")
            active = [channel for channel, phase in zip(channels, phases) if phase != "finished"]
            for channel in wait(active, min(remaining, 1)):
                index = channels.index(channel)
                try:
                    event = json.loads(channel.recv_bytes(1024))
                except (OSError, EOFError, ValueError) as error:
                    raise CoordinationError("Cohort worker ended without evidence") from error
                kind = event.get("type") if isinstance(event, dict) else None
                phase = phases[index]
                if kind == "ready" and phase == "loading":
                    phases[index] = "ready"
                elif kind == "measured" and phase == "measuring":
                    seconds = event.get("seconds")
                    if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or not math.isfinite(seconds) or seconds <= 0:
                        raise CoordinationError("Cohort worker timing is invalid")
                    measured[index] = float(seconds)
                    phases[index] = "measured"
                    if all(value is not None for value in measured):
                        completed = time.perf_counter()
                elif kind == "finished" and phase == "measured":
                    phases[index] = "finished"
                else:
                    raise CoordinationError("Cohort worker failed or violated measurement ordering")
            if started is None and all(phase == "ready" for phase in phases):
                started = time.perf_counter()
                for index, channel in enumerate(channels):
                    phases[index] = "measuring"
                    channel.send_bytes(b"measure")
            if any(process.exitcode is not None for process in children):
                raise CoordinationError("Cohort worker exited before cleanup")
        if started is None or completed is None or completed <= started:
            raise CoordinationError("Cohort measurement is incomplete")
        wall = completed - started
        if any(seconds is None or seconds > wall for seconds in measured):
            raise CoordinationError("Cohort timings are inconsistent")
        return {"wallSeconds": wall, "workerSeconds": measured, "workerPids": [p.pid for p in children]}
    finally:
        for lifetime in lifetimes:
            lifetime.close()
        for process in children:
            process.join(timeout=5)
            if process.is_alive():
                # Covers failures before the child establishes its lifetime watch.
                process.kill()
                process.join(timeout=5)
            process.close()
        for channel in channels:
            channel.close()
