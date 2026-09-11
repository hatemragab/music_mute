import dataclasses
import shutil
import unittest
from unittest.mock import patch

import test_worker as fixtures
from musicmute_worker.worker import Worker


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required"
)
class WarmWorkerTests(unittest.TestCase):
    def setUp(self):
        fixtures.WorkerTests.setUp(self)
        self.config = dataclasses.replace(self.config, reuse_separator=True)
        self.engines = []
        source = self.source

        class Engine:
            def __init__(engine, *args, **kwargs):
                engine.runs = 0
                engine.closed = False
                self.engines.append(engine)

            def run(engine, prepared, output, *, timeout, check):
                check()
                self.assertEqual(prepared.suffix, ".wav")
                self.assertFalse(engine.closed)
                engine.runs += 1
                output.mkdir(parents=True)
                shutil.copyfile(source, output / "vocals.mp3")
                return {"model_load": 1 if engine.runs == 1 else 0}

            def close(engine):
                engine.closed = True

        self.enterContext(patch("musicmute_worker.worker.SeparatorEngine", Engine))

    def test_terminal_cleanup_closes_each_engine_before_next_job(self):
        with Worker(self.config, self.api, self.transfers) as worker:
            self.assertEqual(worker.run_once(), "ready")
            self.api.assignment["jobId"] = "b" * 24
            self.assertEqual(worker.run_once(), "ready")
            self.assertEqual(len(self.engines), 2)
            self.assertTrue(all(engine.runs == 1 for engine in self.engines))
            self.assertTrue(all(engine.closed for engine in self.engines))

    def test_reconcile_closes_engine_before_stopped_attestation(self):
        with Worker(self.config, self.api, self.transfers) as worker:
            self.assertEqual(worker.run_once(), "ready")
            worker.journal.save(self.api.assignment)
            original = self.api.post

            def post(route, body):
                if route == "reconcile":
                    self.assertTrue(self.engines[0].closed)
                return original(route, body)

            self.api.post = post
            self.assertEqual(worker.run_once(), "ready")
            self.assertEqual(len(self.engines), 2)

    def test_changed_separator_reloads_engine_for_next_job(self):
        with Worker(self.config, self.api, self.transfers) as worker:
            self.assertEqual(worker.run_once(), "ready")
            self.separator.write_text(
                self.separator.read_text() + "\n# updated processor\n"
            )
            self.api.assignment["jobId"] = "b" * 24
            self.assertEqual(worker.run_once(), "ready")
            self.assertEqual(len(self.engines), 2)
            self.assertTrue(self.engines[0].closed)

    def test_changed_dependency_reloads_engine_for_next_job(self):
        with Worker(self.config, self.api, self.transfers) as worker:
            self.assertEqual(worker.run_once(), "ready")
            self.api.assignment["jobId"] = "b" * 24
            with patch(
                "musicmute_worker.progress.importlib.metadata.version",
                return_value="new-version",
            ):
                self.assertEqual(worker.run_once(), "ready")
            self.assertEqual(len(self.engines), 2)
            self.assertTrue(self.engines[0].closed)

    def test_cancel_closes_idle_engine_before_acknowledgement(self):
        with Worker(self.config, self.api, self.transfers) as worker:
            self.assertEqual(worker.run_once(), "ready")
            self.api.assignment["cancelRequested"] = True
            original = self.api.post

            def post(route, body):
                if route == "cancelled":
                    self.assertTrue(self.engines[0].closed)
                return original(route, body)

            self.api.post = post
            self.assertEqual(worker.run_once(), "cancelled")
