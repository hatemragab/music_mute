"""Synthetic boundary tests; no native service or credential store is operated."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from musicmute_worker.config import Config
from musicmute_worker.execution import ExecutionClock
from musicmute_worker.launcher import (
    ChildHandshake,
    InstallationBinding,
    Launcher,
    canonical_binding,
    verify_binding,
)
from musicmute_worker.processes import SingleInstance
from musicmute_worker.progress import Progress, installation_session
from musicmute_worker.runtime_types import StatePaths, validate_runtime
from musicmute_worker.worker import Journal, Worker
from worker_test_support import INSTALLATION_ID, config, config_document


class AdapterFixture:
    """One synthetic machine namespace regardless of installation state path."""

    def __init__(self, lock_root, binding):
        self.lock_root = lock_root
        self.binding = binding
        self.secret = canonical_binding(binding)
        self.machine = binding.machine_binding_sha256
        self.stops = []
        self.fail_stop = False
        self.locked = False

    def detect(self):
        return {"os": "linux", "arch": "x64", "machineBindingSha256": self.machine}

    def load_secret(self, name):
        assert name == "installation-binding"
        return self.secret

    @contextmanager
    def acquire_machine_lock(self):
        with SingleInstance(self.lock_root):
            self.locked = True
            try:
                yield self
            finally:
                self.locked = False

    def stop_and_verify_descendants(self, containment_id):
        assert self.locked
        self.stops.append(containment_id)
        if self.fail_stop:
            raise RuntimeError("Fixture containment is unverified")


class ChildFixture:
    containment_id = "fixture-child"
    pid = 123

    def __init__(self, adapter):
        self.adapter = adapter
        self.authorized = False
        self.started = False
        self.change = {}

    def start(self, installation_id, nonce):
        assert self.adapter.locked
        self.started = True
        self.hello = ChildHandshake(
            installation_id, nonce, self.pid, self.containment_id
        )

    def wait_ready(self, timeout_seconds):
        assert timeout_seconds == 30
        return replace(self.hello, **self.change)

    def authorize_processing(self, nonce):
        assert nonce == self.hello.nonce
        self.authorized = True

    def wait(self):
        assert self.authorized and self.adapter.locked
        return 0


class LauncherTests(unittest.TestCase):
    def setUp(self):
        from process_test_support import ProcessTestIsolation

        self.enterContext(ProcessTestIsolation())
        root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.root = root
        self.config = config(
            "https://api.example.com/api/v1", root / "journals", root / "separator.py"
        )
        self.paths = self.config.paths
        self.binding = InstallationBinding.load(
            self.paths.identity / "installation.json"
        )
        self.adapter = AdapterFixture(root / "machine-lock", self.binding)
        self.child = ChildFixture(self.adapter)
        self.launcher = Launcher(self.paths, self.adapter)

    def test_repair_reuses_exact_protected_identity(self):
        path = self.paths.identity / "installation.json"
        before = path.read_bytes()
        self.assertEqual(verify_binding(self.paths, self.adapter), self.binding)
        self.assertEqual(verify_binding(self.paths, self.adapter), self.binding)
        self.assertEqual(path.read_bytes(), before)

    def test_worker_restart_from_different_cwd_preserves_session_and_assignment(self):
        worker = Worker(self.config, object(), object())
        assignment = {
            "jobId": "a" * 24,
            "attemptId": "22222222-2222-4222-8222-222222222222",
            "sessionId": worker.session,
            "generation": 1,
        }
        worker.journal.save(assignment)
        before = (self.paths.journals / "active.json").read_bytes()
        previous = Path.cwd()
        try:
            os.chdir(self.root.parent)
            restored = Worker(self.config, object(), object())
        finally:
            os.chdir(previous)
        self.assertEqual(restored.session, worker.session)
        self.assertEqual(restored.journal.active, assignment)
        self.assertEqual((self.paths.journals / "active.json").read_bytes(), before)

    def test_clone_machine_mismatch_rejects_before_start(self):
        self.adapter.machine = "c" * 64
        with self.assertRaisesRegex(RuntimeError, "another machine"):
            self.launcher.run(self.child)
        self.assertFalse(self.child.started)

    def test_copied_files_without_native_secret_reject(self):
        self.adapter.secret = b"different machine protected binding"
        with self.assertRaisesRegex(RuntimeError, "Protected"):
            self.launcher.run(self.child)
        self.assertFalse(self.child.started)

    def test_machine_lock_excludes_other_state_roots_and_repair(self):
        other = AdapterFixture(self.adapter.lock_root, self.binding)
        with self.adapter.acquire_machine_lock():
            with self.assertRaisesRegex(RuntimeError, "running"):
                with other.acquire_machine_lock():
                    self.fail("Concurrent native ownership")
            with self.assertRaisesRegex(RuntimeError, "running"):
                self.launcher.run(self.child)
        self.assertFalse(self.child.started)

    def test_handshake_holds_lock_through_verified_shutdown(self):
        self.assertEqual(self.launcher.run(self.child), 0)
        self.assertEqual(self.adapter.stops, ["fixture-child"])
        self.assertTrue(self.child.authorized)
        self.assertFalse((self.paths.journals / "launcher-owner.json").exists())

    def test_handshake_rejects_each_foreign_ownership_field(self):
        for change in (
            {"nonce": "wrong"},
            {"installation_id": "wrong"},
            {"pid": 456},
            {"pid": True},
            {"containment_id": "other"},
        ):
            with self.subTest(change=change):
                child = ChildFixture(self.adapter)
                child.change = change
                with self.assertRaisesRegex(RuntimeError, "handshake"):
                    self.launcher.run(child)
                self.assertFalse(child.authorized)

    def test_handshake_timeout_stops_child_before_unlock(self):
        with patch.object(self.child, "wait_ready", side_effect=TimeoutError):
            with self.assertRaises(TimeoutError):
                self.launcher.run(self.child)
        self.assertEqual(self.adapter.stops, ["fixture-child"])
        self.assertFalse(self.child.authorized)

    def test_unverified_stop_keeps_ownership_and_blocks_next_start(self):
        self.adapter.fail_stop = True
        with self.assertRaisesRegex(RuntimeError, "unverified"):
            self.launcher.run(self.child)
        owner = self.paths.journals / "launcher-owner.json"
        before = owner.read_bytes()
        next_child = ChildFixture(self.adapter)
        with self.assertRaisesRegex(RuntimeError, "unverified"):
            self.launcher.run(next_child)
        self.assertFalse(next_child.started)
        self.assertEqual(owner.read_bytes(), before)

    def test_verified_recovery_precedes_next_child_start_without_journal_loss(self):
        self.adapter.fail_stop = True
        with self.assertRaises(RuntimeError):
            self.launcher.run(self.child)
        active = self.paths.journals / "active.json"
        active.write_text("preserved owned assignment")
        self.adapter.fail_stop = False
        self.assertEqual(self.launcher.run(ChildFixture(self.adapter)), 0)
        self.assertEqual(active.read_text(), "preserved owned assignment")
        self.assertEqual(len(self.adapter.stops), 3)

    def test_old_identity_rejected_without_mutating_active_journal(self):
        self.paths.journals.mkdir()
        active = self.paths.journals / "active.json"
        active.write_text("owned assignment")
        identity = self.paths.identity / "installation.json"
        identity.write_text(json.dumps({"version": 1, "workerId": "old"}))
        before = identity.read_bytes()
        with self.assertRaisesRegex(RuntimeError, "without erasing"):
            Worker(self.config, object(), object())
        self.assertEqual(active.read_text(), "owned assignment")
        self.assertEqual(identity.read_bytes(), before)
        self.assertFalse((self.paths.journals / "session.json").exists())

    def test_missing_binding_never_adopts_active_journal(self):
        self.paths.journals.mkdir()
        active = self.paths.journals / "active.json"
        active.write_text("owned assignment")
        (self.paths.identity / "installation.json").unlink()
        with self.assertRaisesRegex(RuntimeError, "identity"):
            Worker(self.config, object(), object())
        self.assertEqual(active.read_text(), "owned assignment")

    def test_changed_worker_identity_refuses_without_rebinding(self):
        changed = replace(self.config, worker_id="another-worker")
        before = (self.paths.identity / "installation.json").read_bytes()
        with self.assertRaisesRegex(RuntimeError, "identity"):
            Worker(changed, object(), object())
        self.assertEqual(
            (self.paths.identity / "installation.json").read_bytes(), before
        )

    def test_old_journal_schemas_are_not_converted_or_erased(self):
        self.paths.journals.mkdir()
        for name, constructor, value in (
            ("active.json", lambda: Journal(self.paths.journals), {"jobId": "a" * 24}),
            (
                "session.json",
                lambda: installation_session(self.paths.journals),
                INSTALLATION_ID,
            ),
            (
                "progress.json",
                lambda: Progress(self.paths.journals, self.root / "separator.py"),
                {"version": 1},
            ),
            (
                "execution.json",
                lambda: ExecutionClock(self.paths.journals),
                {"measurementVersion": 2},
            ),
        ):
            with self.subTest(name=name):
                path = self.paths.journals / name
                path.write_text(json.dumps(value))
                before = path.read_bytes()
                with self.assertRaises(RuntimeError):
                    constructor()
                self.assertEqual(path.read_bytes(), before)

    def test_protocol_two_missing_or_mismatched_installation_stops_before_claim(self):
        for updates in (
            {"protocolVersion": 2},
            {"installationId": None},
            {"installationId": "22222222-2222-4222-8222-222222222222"},
        ):
            with self.subTest(updates=updates):
                from unittest.mock import Mock

                api = Mock()
                api.post.return_value = {
                    "workerId": self.config.worker_id,
                    "installationId": INSTALLATION_ID,
                    "protocolVersion": 3,
                    "state": "enabled",
                    **updates,
                }
                worker = Worker(self.config, api, object())
                with self.assertRaisesRegex(RuntimeError, "identity"):
                    worker._verify_identity()
                api.post.assert_called_once_with("identity", {})

    def test_lifecycle_requires_ack_and_constructs_child_after_recovery(self):
        for response in (False, None, 1):
            with self.assertRaises(RuntimeError):
                self.launcher.run(
                    self.child, lifecycle=lambda factory, reply=response: reply
                )
            self.assertFalse(self.child.started)
        order = []

        def lifecycle(factory):
            self.assertTrue(self.adapter.locked)
            order.append("recovered")
            return True

        def make_child():
            self.assertEqual(order, ["recovered"])
            return self.child

        self.assertEqual(self.launcher.run(make_child, lifecycle=lifecycle), 0)

    def test_lock_bound_factory_and_verifier_cannot_escape_lifecycle(self):
        from musicmute_worker.update.policy import ControlClient
        from test_update_trust import Repository

        repository = Repository()
        client = ControlClient(
            self.binding.api_base_url, self.binding.installation_id, "synthetic-bearer"
        )
        saved = {}

        def lifecycle(factory):
            saved["factory"] = factory
            saved.update(
                factory(
                    client,
                    bootstrap_root=repository.bootstrap,
                    distribution_origin="https://updates.music-mute.com",
                )
            )
            return True

        self.assertEqual(self.launcher.run(self.child, lifecycle=lifecycle), 0)
        with self.assertRaisesRegex(RuntimeError, "escaped"):
            saved["factory"](
                client,
                bootstrap_root=repository.bootstrap,
                distribution_origin="https://updates.music-mute.com",
            )
        decision = {
            "serverTime": "2026-01-01T00:00:00.000Z",
            "policyRevision": 1,
            "action": "prepare",
            "target": repository.target,
            "minimumClaimBuild": 1,
            "allowedFallbackReleaseIds": [],
            "reasonCodes": [],
        }
        with self.assertRaisesRegex(RuntimeError, "escaped"):
            saved["verifier"].resolve(decision)


class SharedContractTests(unittest.TestCase):
    def test_separator_uses_explicit_model_cache(self):
        from unittest.mock import Mock

        from musicmute_worker.separation import load_separator

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            model = root / "models" / "Kim_Vocal_2.onnx"
            runtime = root / "runtime.json"
            runtime.write_text(
                json.dumps(
                    {
                        "status": "qualified",
                        "model": str(model),
                        "provider": "DmlExecutionProvider",
                        "options": {"device_id": "0"},
                        "maxDurationSeconds": 2,
                        "maxRamBytes": 1024**3,
                    }
                )
            )
            session = Mock()
            with (
                patch(
                    "musicmute_worker.separation.gpu_session", return_value=session
                ) as gpu,
                patch("musicmute_worker.separation.KimSeparator") as constructor,
                patch("musicmute_worker.separation.monitor_resources"),
            ):
                load_separator(root / "stems", root / "models", runtime)
            self.assertEqual(gpu.call_args.args[0], model)
            constructor.assert_called_once_with(session, root / "stems", 2)

    def test_runtime_fixture_strict_wire_validation(self):
        path = (
            Path(__file__).resolve().parents[1]
            / "contracts"
            / "worker-protocol-v3.json"
        )
        value = json.loads(path.read_text())["runtime"]
        self.assertEqual(validate_runtime(value), value)
        for update in (
            {"protocolVersion": 2},
            {"protocolVersion": True},
            {"workerBuild": 0},
            {"bootVerified": 1},
            {"extra": 1},
            {"modelSha256": "A" * 64},
        ):
            with self.subTest(update=update), self.assertRaises(ValueError):
                validate_runtime({**value, **update})

    def test_explicit_config_and_identity_survive_different_cwd(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            path, document = config_document(root)
            path.write_text(json.dumps(document))
            previous = Path.cwd()
            try:
                os.chdir(root)
                first = Config.load(path)
                os.chdir(root.parent)
                self.assertEqual(Config.load(path), first)
            finally:
                os.chdir(previous)

    def test_paths_reject_relative_overlapping_and_symlink_roots(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            values = {key: root / key for key in StatePaths.__annotations__}
            for update in (
                {"state": Path("relative")},
                {"events": values["journals"]},
                {"events": values["journals"] / "events"},
            ):
                with self.subTest(update=update), self.assertRaises(ValueError):
                    StatePaths(**{**values, **update})
            (root / "link").symlink_to(root)
            with self.assertRaises(ValueError):
                StatePaths(**{**values, "models": root / "link" / "models"})

    def test_old_config_and_missing_worker_id_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path, document = config_document(Path(directory).resolve())
            for key in ("schema_version", "worker_id", "installation_id", "paths"):
                value = document.copy()
                del value[key]
                path.write_text(json.dumps(value))
                with self.subTest(key=key), self.assertRaises(ValueError):
                    Config.load(path)

    def test_launcher_and_core_import_without_gpu_libraries(self):
        worker = Path(__file__).resolve().parents[1]
        code = """
import importlib.abc, sys
class NoGpu(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'numpy', 'torch', 'onnxruntime', 'audio_separator', 'soundfile'}:
            raise RuntimeError('GPU library crossed the launcher boundary')
sys.meta_path.insert(0, NoGpu())
import musicmute_worker.launcher, musicmute_worker.worker, musicmute_worker.separation
import musicmute_worker.platforms.base
"""
        with tempfile.TemporaryDirectory() as directory:
            subprocess.run(
                [sys.executable, "-c", code],
                cwd=directory,
                env={**os.environ, "PYTHONPATH": str(worker)},
                check=True,
                timeout=20,
            )


if __name__ == "__main__":
    unittest.main()
