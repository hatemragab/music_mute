"""Local-only cold/warm throughput comparison; production keeps one worker slot."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import platform
import signal
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from uuid import uuid4

from .config import Config
from .engine import SeparatorEngine
from .media_limits import MediaLimits
from .power import KeepAwake
from .processes import ProcessRunner
from .worker import Stopping, inspect_audio


def prepare_benchmark_audio(source, runner, check, *, prepared):
    # Offline qualification must exercise the proposed ceiling before it can
    # authorize production. This does not change claimed assignment limits.
    return inspect_audio(
        source,
        runner,
        check,
        prepared=prepared,
        limits=MediaLimits(
            policy_version=2,
            max_duration_seconds=1800,
            duration_inclusive=True,
            max_input_bytes=100_000_000,
            input_bytes_inclusive=True,
            probe_timeout_seconds=600,
        ),
    )


def run_benchmark(
    config: Config,
    inputs: list[Path],
    *,
    repeats: int = 2,
    compare_two: bool = False,
    output_dir: Path | None = None,
    check=lambda: None,
    engine_factory=SeparatorEngine,
    prepare=prepare_benchmark_audio,
) -> dict:
    """Caller holds the native machine lock and has recovered contained processes."""
    if type(repeats) is not int or not 1 <= repeats <= 5 or not inputs:
        raise ValueError("Provide local clips and 1..5 repeats")
    if compare_two and len(inputs) * repeats < 2:
        raise ValueError("Two-engine comparison requires at least two requests")
    sources = [Path(path).resolve(strict=True) for path in inputs]
    if any(not path.is_file() for path in sources):
        raise ValueError("Inputs must be local files")
    run_id = uuid4().hex
    root = (output_dir or config.state_dir / "benchmarks" / run_id).resolve()
    root.mkdir(parents=True, exist_ok=False)
    os.environ.pop("MUSICMUTE_WORKER_SECRET", None)
    started = time.perf_counter()
    report = {
        "version": 1,
        "run_id": run_id,
        "repeats": repeats,
        "clips": [],
        "modes": {},
    }
    report["versions"] = {"python": platform.python_version()}
    for package in ("audio-separator", "onnxruntime-directml", "numpy", "soundfile"):
        try:
            report["versions"][package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            report["versions"][package] = "unavailable"
    clips = []
    requests = []
    cancelled = threading.Event()

    def checked():
        if cancelled.is_set():
            raise Stopping()
        check()

    def mode(name: str, *, cold: bool = False, parallel: bool = False):
        destination = root / name
        destination.mkdir()
        before = time.perf_counter()
        rows = []
        rows_lock = threading.Lock()

        def lane(items, slot):
            engine = None
            try:
                for (identifier, prepared, duration), repeat in items:
                    checked()
                    if engine is None:
                        engine = engine_factory(
                            config.separator,
                            destination / "ipc",
                            slot=slot,
                            model_dir=config.paths.models,
                        )
                    output = destination / f"{identifier}-{repeat}"
                    output.mkdir()
                    start = time.perf_counter()
                    stages = engine.run(
                        prepared,
                        output,
                        timeout=config.processing_timeout_seconds,
                        check=checked,
                    )
                    row = {
                        "clip_id": identifier,
                        "repeat": repeat,
                        "audio_seconds": duration,
                        "wall_seconds": time.perf_counter() - start,
                        "stages_seconds": stages,
                    }
                    with rows_lock:
                        rows.append(row)
                    if cold:
                        engine.close()
                        engine = None
            except BaseException:
                cancelled.set()
                raise
            finally:
                if engine is not None:
                    try:
                        engine.close()
                    except BaseException:
                        cancelled.set()
                        raise

        try:
            if parallel:
                failures = []
                with ThreadPoolExecutor(max_workers=2) as pool:
                    futures = [
                        pool.submit(lane, requests[index::2], f"benchmark-{index + 1}")
                        for index in range(2)
                    ]
                    for future in as_completed(futures):
                        try:
                            future.result()
                        except BaseException as error:  # noqa: BLE001 -- join both lanes before rethrowing
                            failures.append(error)
                if failures:
                    # A peer's cooperative stop must not hide the original failure.
                    raise next(
                        (
                            error
                            for error in failures
                            if not isinstance(error, (Stopping, KeyboardInterrupt))
                        ),
                        failures[0],
                    )
            else:
                lane(requests, "benchmark-1")
        finally:
            elapsed = time.perf_counter() - before
            audio = sum(row["audio_seconds"] for row in rows)
            report["modes"][name] = {
                "completed": len(rows),
                "wall_seconds": elapsed,
                "jobs_per_minute": len(rows) * 60 / elapsed if elapsed > 0 else None,
                "audio_seconds_per_wall_second": (
                    audio / elapsed if elapsed > 0 else None
                ),
                "runs": sorted(rows, key=lambda row: (row["repeat"], row["clip_id"])),
            }

    active_mode = "prepare"
    try:
        with ProcessRunner() as runner:
            for index, source in enumerate(sources, 1):
                check()
                identifier = f"clip-{index:03d}"
                prepared = root / (identifier + ".wav")
                before = time.perf_counter()
                duration = prepare(source, runner, check, prepared=prepared)
                clips.append((identifier, prepared, duration))
                report["clips"].append(
                    {
                        "clip_id": identifier,
                        "audio_seconds": duration,
                        "prepare_seconds": time.perf_counter() - before,
                    }
                )
        requests = [
            (clip, repeat) for repeat in range(1, repeats + 1) for clip in clips
        ]
        active_mode = "cold"
        mode("cold", cold=True)
        active_mode = "warm"
        mode("warm")
        if compare_two:
            active_mode = "two_engines"
            mode("two_engines", parallel=True)
        report["status"] = "completed"
    except BaseException as error:
        stopped = isinstance(error, (Stopping, KeyboardInterrupt))
        report["status"] = "stopped" if stopped else "failed"
        report["failure"] = {
            "mode": active_mode,
            "code": "BENCHMARK_STOPPED" if stopped else "BENCHMARK_FAILED",
        }
        raise
    finally:
        report["wall_seconds"] = time.perf_counter() - started
        with (root / "metrics.json").open("x", encoding="utf-8") as stream:
            json.dump(report, stream, indent=2, allow_nan=False)
    return report


def main(argv=None, *, adapter=None) -> int:
    parser = argparse.ArgumentParser(description="Offline shared separator benchmark")
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--repeats", type=int, choices=range(1, 6), default=2)
    parser.add_argument("--compare-two", action="store_true")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args(argv)
    if adapter is None:
        print('{"error":"NATIVE_ADAPTER_REQUIRED"}')
        return 2
    stop = threading.Event()
    previous = {}
    metrics = None
    try:
        for name in (signal.SIGINT, signal.SIGTERM):
            previous[name] = signal.signal(name, lambda *_: stop.set())

        def check():
            if stop.is_set():
                raise Stopping()

        os.environ.pop("MUSICMUTE_WORKER_SECRET", None)
        config = Config.load(args.config)
        output_dir = (
            args.output_dir or config.state_dir / "benchmarks" / uuid4().hex
        ).resolve()
        with adapter.acquire_machine_lock(), KeepAwake(), ProcessRunner() as runner:
            from .launcher import verify_binding

            verify_binding(config.paths, adapter)
            runner.recover()
            if output_dir.exists():
                raise FileExistsError("Benchmark output already exists")
            metrics = output_dir / "metrics.json"
            report = run_benchmark(
                config,
                args.inputs,
                repeats=args.repeats,
                compare_two=args.compare_two,
                output_dir=output_dir,
                check=check,
            )
        print(json.dumps(report, allow_nan=False))
        return 0
    except (Stopping, KeyboardInterrupt):
        print('{"error":"BENCHMARK_STOPPED"}')
        return 130
    except Exception:  # noqa: BLE001 -- CLI errors must never disclose paths or provider details
        print('{"error":"BENCHMARK_FAILED"}')
        return 2
    finally:
        if metrics is not None and metrics.is_file():
            print(f"Metrics: {metrics.resolve()}")
        for name, handler in previous.items():
            signal.signal(name, handler)


if __name__ == "__main__":
    raise SystemExit(main())
