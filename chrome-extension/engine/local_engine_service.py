"""One private, sequential local engine shared by Chrome and desktop requests.

No network, fleet state or credentials. Disconnect during an active request kills
this process group, including decoder children; the caller never replays work.
Idle engines unload after two minutes and do not hold the app update lease.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import select
import signal
import socket
import stat
import threading
import time

MAX_REQUEST_BYTES = 16 * 1024
IDLE_SECONDS = 120
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")


def private_directory(path: Path) -> None:
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError("ENGINE_SOCKET_UNSAFE")
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError("ENGINE_SOCKET_UNSAFE")


def private_lock(path: Path) -> int:
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    info, named = os.fstat(fd), path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600
            or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
        os.close(fd)
        raise ValueError("ENGINE_SOCKET_UNSAFE")
    return fd


def fingerprint(path: Path) -> tuple:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("RUNTIME_CONFIG_CHANGED")
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def send(client: socket.socket, value: dict) -> None:
    client.sendall((json.dumps(value, separators=(",", ":")) + "\n").encode())


def read_request(client: socket.socket) -> dict:
    data = bytearray()
    client.settimeout(10)
    while b"\n" not in data:
        chunk = client.recv(4096)
        if not chunk:
            raise EOFError()
        data.extend(chunk)
        if len(data) > MAX_REQUEST_BYTES:
            raise ValueError("ENGINE_PROTOCOL_INVALID")
    line, rest = bytes(data).split(b"\n", 1)
    if rest:
        raise ValueError("ENGINE_PROTOCOL_INVALID")
    request = json.loads(line)
    if not isinstance(request, dict):
        raise ValueError("ENGINE_PROTOCOL_INVALID")
    return request


def request_arguments(config: argparse.Namespace, value: dict) -> argparse.Namespace:
    if set(value) != {"operation", "input", "work_root", "sha256"} or value["operation"] != "process":
        raise ValueError("ENGINE_PROTOCOL_INVALID")
    if not all(isinstance(value[key], str) for key in ("input", "work_root", "sha256")):
        raise ValueError("ENGINE_PROTOCOL_INVALID")
    work, source = Path(value["work_root"]), Path(value["input"])
    if (not UUID.fullmatch(work.name) or work.parent != config.service_root / "cache/jobs"
            or source.parent != work or not re.fullmatch(r"[A-Za-z0-9+/]{43}=", value["sha256"])):
        raise ValueError("INVALID_WORK_ROOT")
    private_directory(work)
    info = source.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600
            or not 0 < info.st_size <= 256 * 1024 ** 2):
        raise ValueError("DOWNLOAD_INVALID")
    return argparse.Namespace(input=source, work_root=work, input_sha256=value["sha256"],
        model_cache=config.model_cache, ffmpeg=config.ffmpeg, ffprobe=config.ffprobe)


def guard_disconnect(client: socket.socket, finished: threading.Event) -> None:
    while not finished.wait(0.1):
        try:
            readable, _, _ = select.select([client], [], [], 0)
            if readable and not finished.is_set():
                # A request is exactly one frame; EOF or additional data retires
                # this engine instead of leaving unobservable GPU work running.
                os.killpg(os.getpgrp(), signal.SIGKILL)
                return
        except (OSError, ValueError):
            if not finished.is_set():
                os.killpg(os.getpgrp(), signal.SIGKILL)
            return


def safe_code(error: Exception) -> str:
    candidate = getattr(error, "code", str(error) if isinstance(error, ValueError) else "PROCESSING_FAILED")
    return candidate if isinstance(candidate, str) and re.fullmatch(r"[A-Z_]{1,60}", candidate) else "PROCESSING_FAILED"


def serve(config: argparse.Namespace, payload, pipeline_factory=None) -> int:
    root, address = config.service_root, config.socket
    private_directory(root)
    private_directory(address.parent)
    if address.name != "engine.sock" or not re.fullmatch(r"[a-f0-9]{64}", config.engine_id):
        raise ValueError("ENGINE_SOCKET_UNSAFE")
    lock = private_lock(address.parent / "engine.lock")
    update = None
    server = None
    socket_identity = None
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0  # Another starter won. It owns any existing socket.
        if address.exists():
            prior = address.lstat()
            if not stat.S_ISSOCK(prior.st_mode) or prior.st_uid != os.getuid():
                raise ValueError("ENGINE_SOCKET_UNSAFE")
            address.unlink()
        update = private_lock(root / "update.lock")
        os.environ["MUSICMUTE_UPDATE_LEASE_FD"] = str(update)
        os.environ["MUSICMUTE_LOCAL_ROOT"] = str(root)
        # Propagate our descriptor to decoder children only during processing.
        spec = importlib.util.spec_from_file_location("engine_process_lease", Path(__file__).with_name("process_lease.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.propagate_update_lease()
        sources = [Path(__file__), Path(__file__).with_name("local_pipeline.py")]
        pinned_sources = [fingerprint(path) for path in sources]
        pipeline = None
        pinned_model = None
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(address))
        os.chmod(address, 0o600)
        socket_identity = address.lstat()
        server.listen(4)
        server.settimeout(IDLE_SECONDS)
        while True:
            try:
                client, _ = server.accept()
            except socket.timeout:
                return 0
            with client:
                # Serialize requests; a live client has no engine handshake until
                # prior work completed. Every request holds its own update lease.
                try:
                    fcntl.flock(update, fcntl.LOCK_SH | fcntl.LOCK_NB)
                except BlockingIOError:
                    return 0
                finished = threading.Event()
                guardian = None
                try:
                    if pinned_sources != [fingerprint(path) for path in sources]:
                        return 0
                    send(client, {"type": "ready", "engine_id": config.engine_id, "pid": os.getpid()})
                    value = read_request(client)
                    if value == {"operation": "retire"}:
                        return 0
                    arguments = request_arguments(config, value)
                    client.settimeout(None)
                    guardian = threading.Thread(target=guard_disconnect, args=(client, finished), daemon=True)
                    guardian.start()
                    with open(os.devnull, "w") as discarded, contextlib.redirect_stdout(discarded):
                        from musicmute_engine.artifacts import model_path
                        from musicmute_engine.pipeline import ProcessRequest, RuntimePipeline
                        model = model_path(config.model_cache)
                        model_identity = fingerprint(model)
                        if pinned_model is not None and pinned_model != model_identity:
                            raise ValueError("RUNTIME_CONFIG_CHANGED")
                        pipeline = pipeline or (pipeline_factory or RuntimePipeline)()
                        started = time.monotonic()
                        result = pipeline.process(ProcessRequest.from_payload(payload(arguments)),
                            progress=lambda stage: send(client, {"type": "progress", "stage": stage}),
                            window_progress=lambda completed, total: send(client, {"type": "progress", "stage": "separation", "completed": completed, "total": total}))
                        if fingerprint(model) != model_identity:
                            raise ValueError("RUNTIME_CONFIG_CHANGED")
                        pinned_model = model_identity
                        result["enginePeakRssBytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
                        result["localEngineWarm"] = bool(getattr(config, "completed", False))
                        result["localEngineProcessSeconds"] = time.monotonic() - started
                        config.completed = True
                    finished.set()
                    guardian.join()
                    send(client, {"type": "result", "result": result})
                except (EOFError, BrokenPipeError, ConnectionResetError):
                    if guardian is not None:
                        return 0
                except Exception as error:
                    finished.set()
                    if guardian is not None:
                        guardian.join()
                    with contextlib.suppress(OSError):
                        send(client, {"type": "error", "code": safe_code(error)})
                    return 0  # Never reuse a possibly poisoned GPU/model state.
                finally:
                    finished.set()
                    if guardian is not None:
                        guardian.join()
                    fcntl.flock(update, fcntl.LOCK_UN)
    finally:
        if server is not None:
            server.close()
        if socket_identity is not None:
            with contextlib.suppress(FileNotFoundError):
                named = address.lstat()
                if (named.st_ino, named.st_dev) == (socket_identity.st_ino, socket_identity.st_dev):
                    address.unlink()
        if update is not None:
            os.close(update)
        os.close(lock)
