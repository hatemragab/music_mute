import importlib
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from musicmute_worker.config import Config


class BenchmarkTests(unittest.TestCase):
    def test_offline_preparation_can_qualify_thirty_minute_inputs(self):
        benchmark = importlib.import_module("musicmute_worker.benchmark")
        with patch.object(benchmark, "inspect_audio", return_value=1800) as inspect:
            self.assertEqual(
                benchmark.prepare_benchmark_audio(
                    Path("fixture.m4a"),
                    object(),
                    lambda: None,
                    prepared=Path("output.wav"),
                ),
                1800,
            )
        limits = inspect.call_args.kwargs["limits"]
        self.assertTrue(limits.accepts_duration(1800))
        self.assertFalse(limits.accepts_duration(1800.001))
        self.assertTrue(limits.accepts_input_bytes(100_000_000))

    def setUp(self):
        try:
            self.benchmark = importlib.import_module("musicmute_worker.benchmark")
        except ModuleNotFoundError:
            self.fail("Offline benchmark is not implemented")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "private-title.mp3"
        self.source.write_bytes(b"fixture")
        self.config = Config(
            "https://unused.invalid/api/v1",
            self.root / "state",
            self.root / "separate.py",
        )
        self.engines = []
        self.prepared = []
        self.active = 0
        self.maximum = 0
        self.lock = threading.Lock()
        self.parallel_started = threading.Barrier(2)
        owner = self

        class Engine:
            def __init__(self, separator, state_dir, *, slot):
                self.mode = state_dir.parent.name
                self.slot = slot
                self.thread = threading.get_ident()
                self.calls = []
                self.closed = False
                self.busy = threading.Lock()
                owner.engines.append(self)

            def run(self, prepared, output_dir, *, timeout, check):
                owner.assertEqual(threading.get_ident(), self.thread)
                owner.assertTrue(self.busy.acquire(blocking=False))
                try:
                    check()
                    owner.assertEqual(timeout, owner.config.processing_timeout_seconds)
                    owner.assertTrue(prepared.is_file())
                    self.calls.append((prepared, output_dir))
                    with owner.lock:
                        owner.active += 1
                        owner.maximum = max(owner.maximum, owner.active)
                    if self.mode == "two_engines" and len(self.calls) == 1:
                        owner.parallel_started.wait(timeout=2)
                    time.sleep(0.015)
                    with owner.lock:
                        owner.active -= 1
                    return {
                        "model_load": 0.1 if len(self.calls) == 1 else 0.0,
                        "separation": 0.01,
                    }
                finally:
                    self.busy.release()

            def close(self):
                owner.assertEqual(threading.get_ident(), self.thread)
                self.closed = True

        self.factory = Engine

    def prepare(self, source, runner, check, *, prepared):
        check()
        self.prepared.append(source)
        prepared.write_bytes(b"prepared audio")
        return 12.0

    def run_benchmark(self, **kwargs):
        return self.benchmark.run_benchmark(
            self.config,
            [self.source],
            engine_factory=self.factory,
            prepare=self.prepare,
            **kwargs,
        )

    def test_cold_warm_and_two_engine_counts_reuse_and_anonymous_report(self):
        report = self.run_benchmark(repeats=4, compare_two=True)
        self.assertEqual(self.prepared, [self.source.resolve()])
        self.assertEqual(
            {
                mode: len([e for e in self.engines if e.mode == mode])
                for mode in ("cold", "warm", "two_engines")
            },
            {"cold": 4, "warm": 1, "two_engines": 2},
        )
        self.assertEqual(self.maximum, 2)
        self.assertTrue(all(e.closed for e in self.engines))
        two = [e for e in self.engines if e.mode == "two_engines"]
        self.assertEqual({e.slot for e in two}, {"benchmark-1", "benchmark-2"})
        self.assertEqual([len(e.calls) for e in two], [2, 2])
        for mode in report["modes"].values():
            self.assertEqual(mode["completed"], 4)
            self.assertGreater(mode["wall_seconds"], 0)
            self.assertGreater(mode["audio_seconds_per_wall_second"], 0)
            self.assertEqual({r["clip_id"] for r in mode["runs"]}, {"clip-001"})
        encoded = json.dumps(report)
        self.assertNotIn(self.source.name, encoded)
        self.assertNotIn(str(self.root), encoded)
        saved = list((self.config.state_dir / "benchmarks").glob("*/metrics.json"))
        self.assertEqual(len(saved), 1)
        self.assertEqual(json.loads(saved[0].read_text()), report)
        self.assertEqual(
            set(report["versions"]),
            {"python", "audio-separator", "onnxruntime-directml", "numpy", "soundfile"},
        )

    def test_default_has_one_engine_at_a_time_and_new_output_each_run(self):
        self.run_benchmark(repeats=1)
        self.run_benchmark(repeats=1)
        self.assertEqual(self.maximum, 1)
        self.assertEqual(
            len(list((self.config.state_dir / "benchmarks").glob("*/metrics.json"))), 2
        )

    def test_existing_output_and_invalid_repeats_are_refused_before_engines(self):
        for repeats in (0, 6, True):
            with self.assertRaises(ValueError):
                self.run_benchmark(repeats=repeats)
        with self.assertRaises(FileExistsError):
            self.run_benchmark(output_dir=self.root)
        with self.assertRaises(ValueError):
            self.run_benchmark(repeats=1, compare_two=True)
        self.assertEqual(self.engines, [])

    def test_failure_closes_engine_and_cli_error_is_sanitized(self):
        class FailedEngine(self.factory):
            def run(self, *args, **kwargs):
                raise RuntimeError("private title and secret token")

        with self.assertRaises(RuntimeError):
            self.benchmark.run_benchmark(
                self.config,
                [self.source],
                engine_factory=FailedEngine,
                prepare=self.prepare,
            )
        self.assertTrue(all(e.closed for e in self.engines))
        with (
            patch.object(self.benchmark.platform, "system", return_value="Windows"),
            patch.object(
                self.benchmark.Config,
                "load",
                side_effect=RuntimeError("private secret"),
            ),
            patch("builtins.print") as output,
        ):
            self.assertEqual(self.benchmark.main([str(self.source)]), 2)
        self.assertNotIn("private secret", str(output.call_args_list))

    def test_zero_elapsed_preserves_failure_and_reports_unmeasurable_rates(self):
        class FailedEngine(self.factory):
            def run(self, *args, **kwargs):
                raise RuntimeError("engine failed before clock advanced")

        with (
            patch.object(self.benchmark.time, "monotonic", return_value=10.0),
            patch.object(self.benchmark.time, "perf_counter", return_value=10.0),
            self.assertRaisesRegex(RuntimeError, "engine failed"),
        ):
            self.benchmark.run_benchmark(
                self.config,
                [self.source],
                engine_factory=FailedEngine,
                prepare=self.prepare,
            )
        saved = next((self.config.state_dir / "benchmarks").glob("*/metrics.json"))
        report = json.loads(saved.read_text())
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["modes"]["cold"]["wall_seconds"], 0)
        self.assertIsNone(report["modes"]["cold"]["jobs_per_minute"])
        self.assertIsNone(report["modes"]["cold"]["audio_seconds_per_wall_second"])

    def test_failed_parallel_mode_retains_completed_modes_and_stops_engines(self):
        class FailedEngine(self.factory):
            def run(self, *args, **kwargs):
                if self.mode == "two_engines":
                    raise RuntimeError("private device memory details")
                return super().run(*args, **kwargs)

        with self.assertRaises(RuntimeError):
            self.benchmark.run_benchmark(
                self.config,
                [self.source],
                compare_two=True,
                engine_factory=FailedEngine,
                prepare=self.prepare,
            )
        self.assertTrue(all(engine.closed for engine in self.engines))
        saved = next((self.config.state_dir / "benchmarks").glob("*/metrics.json"))
        report = json.loads(saved.read_text())
        self.assertTrue({"cold", "warm"}.issubset(report["modes"]))
        self.assertEqual(report["status"], "failed")
        self.assertEqual(
            report["failure"], {"mode": "two_engines", "code": "BENCHMARK_FAILED"}
        )
        self.assertNotIn("private device", saved.read_text())

    def test_failed_or_stopped_second_prepare_keeps_first_clip_without_engines(self):
        second = self.root / "another-private-title.mp3"
        second.write_bytes(b"fixture")
        for error in (
            RuntimeError("private prepare failure"),
            self.benchmark.Stopping(),
        ):
            with self.subTest(error=type(error).__name__):
                count = 0

                def prepare(source, runner, check, *, prepared, failure=error):
                    nonlocal count
                    count += 1
                    if count == 2:
                        raise failure
                    return self.prepare(source, runner, check, prepared=prepared)

                output = self.root / type(error).__name__
                with self.assertRaises(type(error)):
                    self.benchmark.run_benchmark(
                        self.config,
                        [self.source, second],
                        output_dir=output,
                        engine_factory=self.factory,
                        prepare=prepare,
                    )
                report = json.loads((output / "metrics.json").read_text())
                self.assertEqual(report["failure"]["mode"], "prepare")
                self.assertEqual(
                    report["status"],
                    (
                        "stopped"
                        if isinstance(error, self.benchmark.Stopping)
                        else "failed"
                    ),
                )
                self.assertEqual(
                    [clip["clip_id"] for clip in report["clips"]], ["clip-001"]
                )
                self.assertEqual(report["modes"], {})
                self.assertEqual(self.engines, [])
                self.assertNotIn("private", json.dumps(report))

    def test_failure_in_mode_preserves_completed_requests(self):
        owner = self

        class FailedEngine(self.factory):
            def run(self, *args, **kwargs):
                if len(owner.engines) == 2:
                    raise RuntimeError("second cold request failed")
                return super().run(*args, **kwargs)

        with self.assertRaises(RuntimeError):
            self.benchmark.run_benchmark(
                self.config,
                [self.source],
                engine_factory=FailedEngine,
                prepare=self.prepare,
            )
        saved = next((self.config.state_dir / "benchmarks").glob("*/metrics.json"))
        report = json.loads(saved.read_text())
        self.assertEqual(report["modes"]["cold"]["completed"], 1)
        self.assertEqual(len(report["modes"]["cold"]["runs"]), 1)
        self.assertEqual(report["status"], "failed")

    def test_relative_output_is_absolute_before_preparation(self):
        destination = self.root / "relative-output"

        def prepare(source, runner, check, *, prepared):
            self.assertTrue(prepared.is_absolute())
            self.assertEqual(prepared.parent, destination.resolve())
            return self.prepare(source, runner, check, prepared=prepared)

        self.benchmark.run_benchmark(
            self.config,
            [self.source],
            repeats=1,
            output_dir=Path(os.path.relpath(destination, Path.cwd())),
            engine_factory=self.factory,
            prepare=prepare,
        )
        self.assertTrue((destination / "metrics.json").is_file())


if __name__ == "__main__":
    unittest.main()
