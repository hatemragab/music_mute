from __future__ import annotations

import unittest
from unittest.mock import patch

from musicmute_engine.windows_gpu import (
    GpuSelectionError, _description_identity, adapter_identity, physical_gpu_id,
    qualify_candidates, ranked_candidates, receipt_identity, require_native_x64,
    resolve_adapter, validate_identity,
)


def gpu(index=0, luid="0000000000000001", memory=0, **changes):
    return {
        "source": "DXGI EnumAdapters1/GetDesc1", "deviceIndex": index,
        "name": "Integrated GPU", "vendorId": 32902, "deviceId": 1234,
        "subsystemId": 5678, "revision": 1, "driverVersion": "32.0.1.1",
        "luid": luid, "dedicatedVideoMemoryBytes": memory,
        "sharedSystemMemoryLimitBytes": 8_000_000_000, **changes,
    }


class WindowsGpuTests(unittest.TestCase):
    def test_ranks_discrete_candidates_then_exact_qualified_preference(self):
        integrated = gpu()
        discrete = gpu(2, "0000000000000002", 8_000_000_000, name="Discrete GPU", vendorId=4318)
        self.assertEqual(ranked_candidates([integrated, discrete]), [discrete, integrated])
        self.assertEqual(ranked_candidates([discrete, integrated], integrated), [integrated, discrete])
        self.assertEqual(ranked_candidates([]), [])

    def test_ordinal_reorder_preserves_identity_but_driver_or_luid_change_requalifies(self):
        original = gpu(2)
        moved = gpu(0)
        self.assertEqual(resolve_adapter(original, [gpu(1, "0000000000000003"), moved]), moved)
        self.assertEqual(receipt_identity(original), receipt_identity(moved))
        self.assertEqual(physical_gpu_id(original), "dxgi-0000000000000001")
        for changed in (gpu(driverVersion="32.0.1.2"), gpu(luid="0000000000000002")):
            with self.assertRaisesRegex(GpuSelectionError, "qualification is required"):
                resolve_adapter(original, [changed])
        with self.assertRaises(GpuSelectionError):
            resolve_adapter(original, [])

    def test_fails_closed_on_missing_ambiguous_or_invalid_identity(self):
        for value in (None, {}, gpu(vendorId=0), gpu(deviceIndex=True), gpu(luid="not-a-luid"), gpu(deviceIndex=16), gpu(name="GPU\nsecret"), gpu(driverVersion="unknown")):
            with self.assertRaises(GpuSelectionError):
                validate_identity(value)
        for entries in ([gpu(), gpu(1)], [gpu(), gpu(0, "0000000000000002")]):
            with self.assertRaises(GpuSelectionError):
                ranked_candidates(entries)
        with patch("musicmute_engine.windows_gpu.enumerate_adapters", return_value=[gpu(1)]):
            self.assertEqual(adapter_identity(1), gpu(1))
            with self.assertRaises(GpuSelectionError):
                adapter_identity(0)

    def test_software_adapter_is_discarded_without_driver_or_device_creation(self):
        import ctypes
        from musicmute_engine.windows_gpu import AdapterDescription
        def description(_adapter, pointer):
            ctypes.cast(pointer, ctypes.POINTER(AdapterDescription)).contents.flags = 2
            return 0
        with patch("musicmute_engine.windows_gpu._method", return_value=description):
            self.assertIsNone(_description_identity(None, 0))

    def test_actual_native_architecture_is_required(self):
        with patch("musicmute_engine.windows_gpu.sys.platform", "darwin"):
            with self.assertRaisesRegex(OSError, "native Windows x64"):
                require_native_x64()

    def test_qualification_tries_each_gpu_once_after_oom_without_cpu_fallback(self):
        attempted = []
        first, second = gpu(1, memory=8_000_000_000), gpu(2, "0000000000000002")
        def qualify(candidate):
            attempted.append(candidate["deviceIndex"])
            if candidate == first:
                raise RuntimeError("GPU out of memory")
            return {"status": "PASS", "gpuIdentity": candidate, "providerDispatch": {"proven": True, "cpuNodeEvents": 0, "acceleratedNodeEvents": 3}}
        result = qualify_candidates(qualify, adapters=[second, first])
        self.assertEqual(attempted, [1, 2])
        self.assertEqual(result["gpuIdentity"], second)

    def test_incomplete_cpu_or_failed_evidence_never_qualifies(self):
        for dispatch in ({}, {"proven": True, "cpuNodeEvents": 1, "acceleratedNodeEvents": 3}, {"proven": True, "cpuNodeEvents": 0, "acceleratedNodeEvents": 0}):
            with self.assertRaisesRegex(GpuSelectionError, "No GPU passed"):
                qualify_candidates(lambda candidate: {"status": "PASS", "gpuIdentity": candidate, "providerDispatch": dispatch}, adapters=[gpu()])
        with self.assertRaisesRegex(GpuSelectionError, "No GPU passed"):
            qualify_candidates(lambda _candidate: {}, adapters=[])


if __name__ == "__main__":
    unittest.main()
