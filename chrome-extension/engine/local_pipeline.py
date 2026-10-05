"""Local-only JSONL bridge. No fleet credentials, enrollment, or telemetry."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import resource
import signal
import subprocess
import sys
import threading
from pathlib import Path


def watch_parent(expected_parent: int) -> None:
    """Node detached this process group; destroy descendants if Node disappears."""
    def watch() -> None:
        while True:
            if os.getppid() != expected_parent:
                os.killpg(os.getpgrp(), signal.SIGKILL)
                return
            threading.Event().wait(0.25)

    threading.Thread(target=watch, name="local-parent-guardian", daemon=True).start()


def emit(stream: object, payload: dict[str, object]) -> None:
    stream.write(json.dumps(payload, separators=(",", ":")) + "\n")
    stream.flush()


def process_payload(arguments: argparse.Namespace) -> dict[str, object]:
    from musicmute_engine.media import sha256_base64
    from musicmute_engine.recipes import recipe_snapshot

    source = arguments.input.resolve(strict=True)
    work_root = arguments.work_root.resolve(strict=True)
    if source.parent != work_root or source.is_symlink():
        raise ValueError("Input is not owned by this attempt")
    return {
        "attemptId": work_root.name,
        "attemptDirectory": str(work_root),
        "input": {
            "path": str(source),
            "bytes": source.stat().st_size,
            "sha256": getattr(arguments, "input_sha256", None) or sha256_base64(source),
        },
        "modelCacheRoot": str(arguments.model_cache.resolve(strict=True)),
        "provider": "mps",
        "directmlDeviceId": 0,
        "ffmpegPath": str(arguments.ffmpeg.resolve(strict=True)),
        "ffprobePath": str(arguments.ffprobe.resolve(strict=True)),
        "recipe": recipe_snapshot("kim-vocals-v2", trim_enabled=False),
    }


def installed_model(path: Path) -> Path:
    """Use the installed model without an integrity audit during normal processing.

    Prepare and explicit doctor checks own content validation. Missing/unreadable
    files still fail, and no download or fallback model is introduced here.
    """
    from musicmute_engine.artifacts import ModelArtifactError
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ModelArtifactError("Installed model is unavailable")
    return path.resolve(strict=True)


def local_pipeline():
    from musicmute_engine.artifacts import model_path
    from musicmute_engine.pipeline import RuntimePipeline
    return RuntimePipeline(
        model_resolver=lambda root: installed_model(model_path(root)),
        model_validator=installed_model,
    )


def install_process_lease():
    if "MUSICMUTE_UPDATE_LEASE_FD" not in os.environ:
        return
    import importlib.util
    resources = os.environ.get("MUSICMUTE_LOCAL_APP_RESOURCES")
    if not resources or not Path(resources).is_absolute():
        raise ValueError("LOCAL_UPDATE_LEASE_INVALID")
    spec = importlib.util.spec_from_file_location("musicmute_process_lease", Path(resources) / "engine/process_lease.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.propagate_update_lease()


def main() -> int:
    os.umask(0o077)
    # Direct developer invocations also get a private process group. Never kill
    # the caller's shell/session when the guardian notices parent termination.
    if os.getpgrp() != os.getpid():
        os.setsid()
    if "--serve" not in sys.argv:
        watch_parent(int(os.environ.get("MUSICMUTE_LOCAL_PARENT_PID", os.getppid())))
    try:
        install_process_lease()
    except (OSError, ValueError, ImportError):
        sys.stderr.write("LOCAL_UPDATE_LEASE_INVALID\n")
        return 76
    # Acquisition children share this owned process group and inherited pipes.
    if len(sys.argv) > 2 and sys.argv[1] == "--tool":
        executable = sys.argv[2]
        if not Path(executable).is_absolute() or len(sys.argv) < 4 or sys.argv[3] != "--":
            return 2
        tool_arguments = sys.argv[4:]
        # Only the explicit metadata replay receives the parent's bounded input.
        # All other tools see EOF, even if their caller accidentally supplies data.
        replay_options = [
            index for index, value in enumerate(tool_arguments)
            if value == "--load-info-json" or value.startswith("--load-info-json=")
        ]
        replay_stdin = (
            len(replay_options) == 1
            and tool_arguments[replay_options[0]:replay_options[0] + 2] == ["--load-info-json", "-"]
        )
        return subprocess.call(
            [executable, *tool_arguments],
            stdin=None if replay_stdin else subprocess.DEVNULL,
        )

    parser = argparse.ArgumentParser()
    parser.add_argument("--doctor", action="store_true")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--service-root", type=Path)
    parser.add_argument("--socket", type=Path)
    parser.add_argument("--engine-id")
    parser.add_argument("--input-sha256")
    parser.add_argument("--input", type=Path)
    parser.add_argument("--work-root", type=Path)
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path)
    parser.add_argument("--ffprobe", type=Path)
    arguments = parser.parse_args()
    if arguments.serve:
        import importlib.util
        spec = importlib.util.spec_from_file_location("local_engine_service", Path(__file__).with_name("local_engine_service.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.serve(arguments, process_payload, local_pipeline)
    # A dedicated duplicated pipe also keeps C/native stdout away from JSONL.
    control_stream = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    with contextlib.redirect_stdout(sys.stderr):
        try:
            from musicmute_engine.artifacts import verified_cached_model
            from musicmute_engine.provider_adapter import discover_provider

            if arguments.doctor:
                discover_provider("mps", 0)
                verified_cached_model(arguments.model_cache)
                emit(control_stream, {"ready": True, "provider": "mps", "trim_enabled": False})
                return 0

            from musicmute_engine.pipeline import ProcessRequest

            if any(value is None for value in (arguments.input, arguments.work_root, arguments.ffmpeg, arguments.ffprobe)):
                raise ValueError("Processing paths are required")
            request = ProcessRequest.from_payload(process_payload(arguments))
            result = local_pipeline().process(
                request,
                progress=lambda stage: emit(control_stream, {"type": "progress", "stage": stage}),
                window_progress=lambda completed, total: emit(control_stream, {
                    "type": "progress", "stage": "separation", "completed": completed, "total": total,
                }),
            )
            # macOS ru_maxrss reports bytes. GPU values are end-of-job samples.
            result["enginePeakRssBytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            try:
                import torch
                result["engineMpsAllocatedBytes"] = torch.mps.current_allocated_memory()
                result["engineMpsDriverAllocatedBytes"] = torch.mps.driver_allocated_memory()
            except Exception:
                # Optional diagnostics cannot invalidate completed inference.
                pass
            emit(control_stream, {"type": "result", "result": result})
            return 0
        except Exception as error:
            # Only a fixed code leaves this boundary. Never send exception text.
            code = getattr(error, "code", "ENGINE_NOT_READY" if arguments.doctor else "PROCESSING_FAILED")
            if not isinstance(code, str) or not code.replace("_", "").isalpha() or not code.isupper():
                code = "PROCESSING_FAILED"
            if arguments.doctor:
                emit(control_stream, {"ready": False, "code": code})
                return 0
            emit(control_stream, {"type": "error", "code": code})
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
