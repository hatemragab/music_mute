from __future__ import annotations

import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from threading import Event, Thread

from musicmute_engine.provider_adapter import (
    DIRECTML_PROVIDER,
    DISABLE_CPU_FALLBACK,
    ProviderAdapterError,
    discover_provider,
    provider_session,
    _protect_directml_session,
)


class FakeSessionOptions:
    execution_mode: object | None = None
    enable_mem_pattern = True

    def __init__(self) -> None:
        self.configuration: dict[str, str] = {}

    def add_session_config_entry(self, key: str, value: str) -> None:
        self.configuration[key] = value

    def get_session_config_entry(self, key: str) -> str:
        return self.configuration.get(key, "")


class FakeSession:
    def __init__(self, options: FakeSessionOptions, providers: list[str], enable_fallback: bool) -> None:
        self.options = options
        self.providers = providers
        self.fallback = enable_fallback
        self.run_error: RuntimeError | None = None
        self.runs = 0

    def get_providers(self) -> list[str]:
        return self.providers

    def get_session_options(self) -> FakeSessionOptions:
        return self.options

    def disable_fallback(self) -> None:
        self.fallback = False

    def set_providers(self, providers: list[str]) -> None:
        self.providers = providers

    def enable_fallback(self) -> None:
        self.fallback = True

    def run(self, *_arguments: object) -> list[object]:
        self.runs += 1
        if self.run_error is not None:
            if self.fallback:
                self.set_providers(["CPUExecutionProvider"])
                return ["cpu-result"]
            raise self.run_error
        return ["gpu-result"]


class FakeExecutionMode:
    ORT_SEQUENTIAL = "sequential"


class FakeOnnxRuntime:
    SessionOptions = FakeSessionOptions
    ExecutionMode = FakeExecutionMode

    def __init__(self, providers: list[str]) -> None:
        self.providers = providers
        self.calls: list[dict[str, object]] = []
        self.InferenceSession = self._session

    def get_available_providers(self) -> list[str]:
        return self.providers

    def _session(self, path: object, **kwargs: object) -> FakeSession:
        call = {"path": path, **kwargs}
        self.calls.append(call)
        return FakeSession(kwargs["sess_options"], self.providers.copy(), bool(kwargs.get("enable_fallback", True)))


class ProviderAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        # These sessions are injected fixtures, never native GPU execution.
        native = patch("musicmute_engine.windows_gpu.require_native_x64")
        native.start()
        self.addCleanup(native.stop)
        hardware = patch("musicmute_engine.windows_gpu.adapter_identity", return_value={"luid": "fixture-physical-gpu"})
        hardware.start()
        self.addCleanup(hardware.stop)

    def test_x64_process_on_an_arm_host_cannot_pass_provider_discovery(self) -> None:
        with (
            patch("musicmute_engine.provider_adapter.platform.system", return_value="Windows"),
            patch("musicmute_engine.provider_adapter.platform.machine", return_value="AMD64"),
            patch("musicmute_engine.windows_gpu.require_native_x64", side_effect=OSError("ARM64 native host")),
        ):
            with self.assertRaisesRegex(ProviderAdapterError, "native Windows x64"):
                discover_provider("directml", 0)

    def test_software_adapter_and_creation_time_reorder_fail_before_model_execution(self) -> None:
        runtime = FakeOnnxRuntime([DIRECTML_PROVIDER, "CPUExecutionProvider"])
        with (
            patch("musicmute_engine.provider_adapter.platform.system", return_value="Windows"),
            patch("musicmute_engine.provider_adapter.platform.machine", return_value="AMD64"),
            patch("musicmute_engine.windows_gpu.adapter_identity", side_effect=RuntimeError("software adapter")),
        ):
            with self.assertRaisesRegex(ProviderAdapterError, "hardware"):
                discover_provider("directml", 0)
        with (
            patch("musicmute_engine.provider_adapter.ProviderAdapter.discover"),
            patch("musicmute_engine.provider_adapter._onnxruntime", return_value=runtime),
            patch("musicmute_engine.windows_gpu.adapter_identity", side_effect=[{"luid": "gpu-a"}, {"luid": "gpu-b"}]),
        ):
            with provider_session("directml", 1):
                with self.assertRaisesRegex(ProviderAdapterError, "changed during"):
                    runtime.InferenceSession("model.onnx")

    def test_mps_discovery_requires_uvr_runtime_and_available_apple_gpu(self) -> None:
        torch = SimpleNamespace(
            backends=SimpleNamespace(
                mps=SimpleNamespace(is_built=lambda: True, is_available=lambda: True)
            )
        )
        with (
            patch("musicmute_engine.provider_adapter.platform.system", return_value="Darwin"),
            patch("musicmute_engine.provider_adapter.platform.machine", return_value="arm64"),
            patch(
                "musicmute_engine.provider_adapter._package_version",
                side_effect=lambda name: "test"
                if name in {"torch", "onnx2torch"}
                else None,
            ),
            patch.dict("sys.modules", {"torch": torch}),
        ):
            discovery = discover_provider("mps", 0)

        self.assertEqual(discovery.adapter_id, "macos-arm64-mps-v1")
        self.assertEqual(discovery.execution_provider, "MPS")

    def test_directml_pins_device_and_sequential_session_settings(self) -> None:
        runtime = FakeOnnxRuntime([DIRECTML_PROVIDER, "CPUExecutionProvider"])
        with (
            patch("musicmute_engine.provider_adapter.platform.system", return_value="Windows"),
            patch("musicmute_engine.provider_adapter.platform.machine", return_value="AMD64"),
            patch(
                "musicmute_engine.provider_adapter._package_version",
                side_effect=lambda name: (
                    "1.24.4" if name == "onnxruntime-directml" else None
                ),
            ),
            patch("musicmute_engine.provider_adapter._onnxruntime", return_value=runtime),
        ):
            discovery = discover_provider("directml", 3)
            self.assertEqual(discovery.adapter_id, "windows-x64-directml-v1")
            with provider_session("directml", 3):
                runtime.InferenceSession("model.onnx")

        call = runtime.calls[0]
        self.assertEqual(call["providers"][0], (DIRECTML_PROVIDER, {"device_id": "3"}))
        options = call["sess_options"]
        self.assertEqual(options.execution_mode, "sequential")
        self.assertFalse(options.enable_mem_pattern)
        self.assertEqual(call["providers"], [(DIRECTML_PROVIDER, {"device_id": "3"})])
        self.assertIs(call["enable_fallback"], False)
        self.assertEqual(options.get_session_config_entry(DISABLE_CPU_FALLBACK), "1")

    def test_normal_inference_cannot_recreate_or_fallback_to_cpu_after_device_loss(self) -> None:
        runtime = FakeOnnxRuntime([DIRECTML_PROVIDER, "CPUExecutionProvider"])
        with (
            patch("musicmute_engine.provider_adapter.platform.system", return_value="Windows"),
            patch("musicmute_engine.provider_adapter.platform.machine", return_value="AMD64"),
            patch("musicmute_engine.provider_adapter._package_version", side_effect=lambda name: "1.24.4" if name == "onnxruntime-directml" else None),
            patch("musicmute_engine.provider_adapter._onnxruntime", return_value=runtime),
        ):
            with provider_session("directml", 2):
                created = runtime.InferenceSession("model.onnx")
            # Protection remains after the constructor hook has been restored.
            created.run_error = RuntimeError("GPU device removed / out of memory")
            with self.assertRaisesRegex(RuntimeError, "GPU device removed"):
                created.run([], {})
            self.assertEqual(created.runs, 1)
            self.assertEqual(created.get_providers(), [DIRECTML_PROVIDER, "CPUExecutionProvider"])
            with self.assertRaises(ProviderAdapterError):
                created.set_providers(["CPUExecutionProvider"])
            with self.assertRaises(ProviderAdapterError):
                created.enable_fallback()
            created.providers = ["CPUExecutionProvider"]
            with self.assertRaisesRegex(ProviderAdapterError, "lost its DirectML"):
                created.run([], {})
            self.assertEqual(created.runs, 1)

    def test_constructor_cpu_fallback_or_missing_config_support_fails_before_inference(self) -> None:
        runtime = FakeOnnxRuntime(["CPUExecutionProvider"])
        with patch("musicmute_engine.provider_adapter.ProviderAdapter.discover"), patch("musicmute_engine.provider_adapter._onnxruntime", return_value=runtime):
            with provider_session("directml", 0):
                with self.assertRaisesRegex(ProviderAdapterError, "lost its DirectML"):
                    runtime.InferenceSession("model.onnx")
        runtime.SessionOptions = lambda: SimpleNamespace()
        with patch("musicmute_engine.provider_adapter.ProviderAdapter.discover"), patch("musicmute_engine.provider_adapter._onnxruntime", return_value=runtime):
            with provider_session("directml", 0):
                with self.assertRaisesRegex(ProviderAdapterError, "cannot prevent"):
                    runtime.InferenceSession("model.onnx")

    def strict_session(self, session_type: type[FakeSession] = FakeSession) -> FakeSession:
        options = FakeSessionOptions()
        options.add_session_config_entry(DISABLE_CPU_FALLBACK, "1")
        session = session_type(options, [DIRECTML_PROVIDER], False)
        _protect_directml_session(session, 2)
        return session

    def test_first_inference_measurement_requires_success_and_does_not_change_after_later_runs(self) -> None:
        session = self.strict_session()
        session.run_error = RuntimeError("device error")
        with patch("musicmute_engine.provider_adapter.time.perf_counter", return_value=10):
            with self.assertRaises(RuntimeError):
                session.run([], {})
        self.assertFalse(hasattr(session, "musicmute_first_inference_seconds"))
        session.run_error = None
        with patch("musicmute_engine.provider_adapter.time.perf_counter", side_effect=[10, 10.125, 20]):
            self.assertEqual(session.run([], {}), ["gpu-result"])
            self.assertEqual(session.run([], {}), ["gpu-result"])
        self.assertEqual(session.musicmute_first_inference_seconds, 0.125)

    def test_async_first_inference_measurement_waits_for_once_only_successful_native_completion(self) -> None:
        callbacks = []
        class AsyncSession(FakeSession):
            def run_async(self, _names, _feed, callback, data, _options=None):
                callbacks.append((callback, data))
        session = self.strict_session(AsyncSession)
        with patch("musicmute_engine.provider_adapter.time.perf_counter", side_effect=[10, 10.25]):
            session.run_async([], {}, lambda *_args: None, None)
            self.assertFalse(hasattr(session, "musicmute_first_inference_seconds"))
            callback, data = callbacks[0]
            callback([], data, "")
            callback([], data, "")
        self.assertEqual(session.musicmute_first_inference_seconds, 0.25)

    def test_one_session_serializes_actual_threads_across_sync_run_entry_points(self) -> None:
        first = Event()
        second = Event()
        release = Event()
        submitted = Event()
        failures: list[BaseException] = []

        class BlockingSession(FakeSession):
            def run(self, *_arguments: object) -> list[object]:
                first.set()
                if not release.wait(2):
                    raise RuntimeError("fixture timed out")
                return ["gpu-first"]

            def run_with_iobinding(self, *_arguments: object) -> list[object]:
                second.set()
                return ["gpu-next"]

        session = self.strict_session(BlockingSession)

        def execute(method: object, ready: Event | None = None) -> None:
            if ready is not None:
                ready.set()
            try:
                method([], {})
            except BaseException as error:
                failures.append(error)

        running = Thread(target=execute, args=(session.run,), daemon=True)
        following = Thread(target=execute, args=(session.run_with_iobinding, submitted), daemon=True)
        running.start()
        self.assertTrue(first.wait(1))
        following.start()
        try:
            self.assertTrue(submitted.wait(1))
            self.assertFalse(second.wait(0.05), "one DirectML session overlapped Run entry points")
            # Distinct sessions remain independent; serialization is not global.
            self.assertEqual(self.strict_session().run([], {}), ["gpu-result"])
        finally:
            release.set()
            running.join(2)
            following.join(2)
        self.assertFalse(running.is_alive())
        self.assertFalse(following.is_alive())
        self.assertTrue(second.is_set())
        self.assertEqual(failures, [])

    def test_async_run_keeps_exclusion_until_completion_and_releases_before_user_callback_once(self) -> None:
        callbacks: list[object] = []
        entries = Event()
        submitted = Event()
        user_calls: list[object] = []
        failures: list[BaseException] = []

        class AsyncSession(FakeSession):
            def run_async(self, _names: object, _feed: object, callback: object,
                          user_data: object, _options: object = None) -> None:
                callbacks.append((callback, user_data))

            def run(self, *_arguments: object) -> list[object]:
                entries.set()
                return ["gpu-result"]

        session = self.strict_session(AsyncSession)

        def user_callback(_results: object, data: object, _error: object) -> None:
            user_calls.append(data)
            # Callback code can safely execute another Run after native completion.
            self.assertEqual(session.run([], {}), ["gpu-result"])

        session.run_async([], {}, user_callback, "captured-user-data")

        def following() -> None:
            submitted.set()
            try:
                session.run([], {})
            except BaseException as error:
                failures.append(error)

        waiting = Thread(target=following, daemon=True)
        waiting.start()
        self.assertTrue(submitted.wait(1))
        self.assertFalse(entries.wait(0.05), "async submission returned before native completion")
        callback, data = callbacks[0]
        def complete() -> None:
            try:
                callback(["gpu"], data, "")
            except BaseException as error:
                failures.append(error)

        completed = Thread(target=complete, daemon=True)
        completed.start()
        completed.join(2)
        waiting.join(2)
        self.assertFalse(completed.is_alive(), "user callback ran under the inference lock")
        self.assertFalse(waiting.is_alive())
        callback(["duplicate"], data, "")
        self.assertEqual(user_calls, ["captured-user-data"])
        self.assertEqual(failures, [])

    def test_unknown_async_submission_error_retains_lock_until_actual_late_completion(self) -> None:
        callbacks: list[object] = []
        entered = Event()
        submitted = Event()

        class UnknownSession(FakeSession):
            def run_async(self, _names: object, _feed: object, callback: object,
                          user_data: object, _options: object = None) -> None:
                callbacks.append((callback, user_data))
                raise RuntimeError("submission acknowledgement lost")

            def run(self, *_arguments: object) -> list[object]:
                entered.set()
                return ["gpu-result"]

        session = self.strict_session(UnknownSession)
        user_callback = lambda *_arguments: None
        with self.assertRaisesRegex(RuntimeError, "acknowledgement lost"):
            session.run_async([], {}, user_callback, None)

        def following() -> None:
            submitted.set()
            session.run([], {})

        waiting = Thread(target=following, daemon=True)
        waiting.start()
        try:
            self.assertTrue(submitted.wait(1))
            self.assertFalse(entered.wait(0.05))
        finally:
            callback, data = callbacks[0]
            callback([], data, "native operation ended with an error")
            waiting.join(2)
        self.assertFalse(waiting.is_alive())
        self.assertTrue(entered.is_set())

    def test_qualification_profiling_collects_only_created_sessions(self) -> None:
        runtime = FakeOnnxRuntime([DIRECTML_PROVIDER, "CPUExecutionProvider"])
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("musicmute_engine.provider_adapter.platform.system", return_value="Windows"),
            patch("musicmute_engine.provider_adapter.platform.machine", return_value="AMD64"),
            patch(
                "musicmute_engine.provider_adapter._package_version",
                side_effect=lambda name: "1.24.4"
                if name == "onnxruntime-directml"
                else None,
            ),
            patch("musicmute_engine.provider_adapter._onnxruntime", return_value=runtime),
        ):
            profile_directory = Path(directory).resolve()
            with provider_session(
                "directml", 0, profile_directory=profile_directory
            ) as sessions:
                created = runtime.InferenceSession("model.onnx")

        self.assertEqual(sessions, [created])
        options = runtime.calls[0]["sess_options"]
        self.assertTrue(options.enable_profiling)
        self.assertTrue(
            options.profile_file_prefix.startswith(str(profile_directory))
        )

    def test_unqualified_hosts_distributions_and_devices_fail_closed(self) -> None:
        runtime = FakeOnnxRuntime([DIRECTML_PROVIDER])
        with (
            patch("musicmute_engine.provider_adapter.platform.system", return_value="Linux"),
            patch("musicmute_engine.provider_adapter.platform.machine", return_value="x86_64"),
        ):
            with self.assertRaises(ProviderAdapterError):
                discover_provider("directml", 0)

        with (
            patch("musicmute_engine.provider_adapter.platform.system", return_value="Windows"),
            patch("musicmute_engine.provider_adapter.platform.machine", return_value="AMD64"),
            patch(
                "musicmute_engine.provider_adapter._package_version",
                return_value="conflicting",
            ),
            patch("musicmute_engine.provider_adapter._onnxruntime", return_value=runtime),
        ):
            with self.assertRaises(ProviderAdapterError):
                discover_provider("directml", 0)

        with self.assertRaises(ProviderAdapterError):
            discover_provider("directml", 16)


if __name__ == "__main__":
    unittest.main()
