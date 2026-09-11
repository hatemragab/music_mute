"""Command-line entry point; normal operation is Windows-only."""

import argparse
import ast
import logging
import os
import shutil
import signal
import sys
import threading
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .config import Config, configure_installation
from .power import KeepAwake
from .processes import ProcessRunner, SingleInstance
from .transport import Api, ApiError, Transfers
from .worker import LeaseLost, Stopping, Worker


def diagnose(config: Config) -> None:
    if sys.version_info < (3, 11):
        raise RuntimeError("Python 3.11 or later is required")
    if not config.separator.is_file():
        raise RuntimeError("Configured separate.py was not found")
    ast.parse(config.separator.read_text(encoding="utf-8-sig"))
    for executable in ("ffmpeg", "ffprobe"):
        if not shutil.which(executable):
            raise RuntimeError(f"{executable} is missing from PATH")
    with ProcessRunner() as runner:
        runner.recover()
        code = (
            "import importlib.metadata as m; import onnxruntime as ort; "
            "from audio_separator.separator import Separator; "
            "assert 'DmlExecutionProvider' in ort.get_available_providers(), 'DirectML provider missing'; "
            "s=Separator(use_directml=True); "
            "assert 'DmlExecutionProvider' in s.onnx_execution_provider, 'DirectML not selected'; "
            "print('audio-separator='+m.version('audio-separator')); "
            "print('onnxruntime-directml='+m.version('onnxruntime-directml')); "
            "print('numpy='+m.version('numpy')); print('soundfile='+m.version('soundfile')); "
            "print('DirectML available')"
        )
        result = runner.run(
            [sys.executable, "-c", code],
            cwd=config.separator.parent,
            timeout=120,
            check=lambda: None,
            capture=True,
        )
        # Only print selected diagnostic lines; imported libraries may print paths.
        for line in result.stdout.splitlines():
            if (
                line.startswith(
                    (
                        "audio-separator=",
                        "onnxruntime-directml=",
                        "numpy=",
                        "soundfile=",
                    )
                )
                or line == "DirectML available"
            ):
                print(line)
    print("Local checks passed: separator syntax, FFmpeg, FFprobe and DirectML.")
    print("No queued job was claimed. Next run with --once for the live test.")


def main() -> int:
    parser = argparse.ArgumentParser(description="MusicMute Windows queue worker")
    parser.add_argument("--config", type=Path, default=Path("worker.config.json"))
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check local dependencies without claiming work",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Process one job (or exit if the queue is empty)",
    )
    parser.add_argument(
        "--configure-installation",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--api-base-url", help=argparse.SUPPRESS)
    parser.add_argument("--worker-id", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.configure_installation:
        if args.check or args.once or not args.api_base_url or not args.worker_id:
            parser.error("configuration requires an API URL and worker ID")
        try:
            configure_installation(
                args.config.resolve().parent, args.api_base_url, args.worker_id
            )
            return 0
        except (RuntimeError, ValueError) as error:
            print(str(error), file=sys.stderr)
            return 2
    if os.name != "nt":
        print(
            "The worker runs on Windows 10/11. Unit tests support macOS/Linux.",
            file=sys.stderr,
        )
        return 2
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    try:
        config = Config.load(args.config)
        with SingleInstance(config.state_dir):
            if args.check:
                diagnose(config)
                return 0
            secret = os.environ.pop("MUSICMUTE_WORKER_SECRET", "")
            if not secret:
                raise RuntimeError(
                    "Worker secret missing; run Configure-Worker.ps1 then Start-Worker.ps1"
                )
            # Keep the bearer value in this process only; separator children must
            # never inherit it in their environment.
            api = Api(config.api_base_url, secret)
            del secret
            config.state_dir.mkdir(parents=True, exist_ok=True)
            file_log = RotatingFileHandler(
                config.state_dir / "worker.log",
                maxBytes=1_000_000,
                backupCount=3,
                encoding="utf-8",
            )
            logging.basicConfig(
                level=logging.INFO,
                format="%(asctime)s %(levelname)s %(message)s",
                handlers=[logging.StreamHandler(), file_log],
            )
            with KeepAwake(), Worker(config, api, Transfers(), stop) as worker:
                return run_loop(worker, stop, once=args.once)
    except (Stopping, KeyboardInterrupt):
        print("Worker stopped; the saved assignment will be reconciled on restart.")
        return 0
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 2
    except Exception as error:  # noqa: BLE001 -- last boundary must redact unexpected provider errors
        # Never print provider/subprocess exceptions: they can include URLs,
        # command lines or credentials. Diagnostic details stay on the PC via
        # the user's direct separator command when needed.
        print(
            f"Worker stopped safely ({type(error).__name__}). Check configuration and run Start-Worker.ps1 -Check.",
            file=sys.stderr,
        )
        return 2


def run_loop(worker: Worker, stop: threading.Event, *, once: bool = False) -> int:
    """Long poll when idle; back off connection failures without losing progress."""
    log = logging.getLogger("musicmute.worker")
    failures = 0
    while not stop.is_set():
        try:
            wait = 0 if once else worker.config.claim_wait_seconds
            outcome = worker.run_once(wait_seconds=wait)
            failures = 0
            if once:
                print("One-job run finished: " + outcome)
                return 0 if outcome in ("ready", "idle", "cancelled") else 1
            if outcome == "idle" and (not wait or not worker.long_poll_supported):
                stop.wait(1)
        except (LeaseLost, ApiError) as error:
            worker.close()
            if (
                isinstance(error, ApiError)
                and not error.retryable
                and error.status in (400, 401, 403, 404)
            ):
                log.error(
                    "Worker API rejected request: %s. Check backend URL and worker secret.",
                    error.code,
                )
                return 2
            log.warning(
                "Connection or assignment changed; stopped processing and will reconcile"
            )
            if once:
                print(
                    "Run interrupted. Run --once again to reconcile the saved assignment."
                )
                return 1
            delay = min(2 ** min(failures, 4), 15)
            if isinstance(error, ApiError):
                delay = max(delay, error.retry_after or 0)
            failures += 1
            stop.wait(delay)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
