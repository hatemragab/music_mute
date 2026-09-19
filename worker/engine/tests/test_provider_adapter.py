from __future__ import annotations

import unittest
from unittest.mock import patch

from musicmute_engine.provider_adapter import (
    COREML_PROVIDER,
    DIRECTML_PROVIDER,
    ProviderAdapterError,
    discover_provider,
    provider_session,
)


class FakeSessionOptions:
    execution_mode: object | None = None
    enable_mem_pattern = True


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

    def _session(self, path: object, **kwargs: object) -> dict[str, object]:
        call = {"path": path, **kwargs}
        self.calls.append(call)
        return call


class ProviderAdapterTests(unittest.TestCase):
    def test_coreml_discovery_and_session_policy_are_explicit(self) -> None:
        runtime = FakeOnnxRuntime([COREML_PROVIDER, "CPUExecutionProvider"])
        with (
            patch("musicmute_engine.provider_adapter.platform.system", return_value="Darwin"),
            patch("musicmute_engine.provider_adapter.platform.machine", return_value="arm64"),
            patch(
                "musicmute_engine.provider_adapter._package_version",
                side_effect=lambda name: "1.24.4" if name == "onnxruntime" else None,
            ),
            patch("musicmute_engine.provider_adapter._onnxruntime", return_value=runtime),
        ):
            discovery = discover_provider("coreml", 0)
            self.assertEqual(discovery.adapter_id, "macos-arm64-coreml-v1")
            with provider_session("coreml", 0):
                runtime.InferenceSession("model.onnx")

        providers = runtime.calls[0]["providers"]
        self.assertEqual(providers[0][0], COREML_PROVIDER)
        self.assertEqual(providers[0][1]["MLComputeUnits"], "CPUAndGPU")

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

    def test_unqualified_hosts_distributions_and_devices_fail_closed(self) -> None:
        runtime = FakeOnnxRuntime([COREML_PROVIDER])
        with (
            patch("musicmute_engine.provider_adapter.platform.system", return_value="Linux"),
            patch("musicmute_engine.provider_adapter.platform.machine", return_value="x86_64"),
        ):
            with self.assertRaises(ProviderAdapterError):
                discover_provider("coreml", 0)

        with (
            patch("musicmute_engine.provider_adapter.platform.system", return_value="Darwin"),
            patch("musicmute_engine.provider_adapter.platform.machine", return_value="arm64"),
            patch(
                "musicmute_engine.provider_adapter._package_version",
                return_value="conflicting",
            ),
            patch("musicmute_engine.provider_adapter._onnxruntime", return_value=runtime),
        ):
            with self.assertRaises(ProviderAdapterError):
                discover_provider("coreml", 0)

        with self.assertRaises(ProviderAdapterError):
            discover_provider("directml", 16)


if __name__ == "__main__":
    unittest.main()
