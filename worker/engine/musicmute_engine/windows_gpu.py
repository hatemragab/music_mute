"""DXGI hardware discovery and qualification-bound DirectML ordinal selection.

Ordinals are transient. LUID identifies a physical adapter during a Windows boot;
a changed LUID is deliberately requalified rather than mistaken for the same GPU.
No product-name or minimum-VRAM allowlist is used as a qualification substitute.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import re
import sys
import uuid
from typing import Callable, Iterable

MAX_DEVICE_INDEX = 15  # Shared engine request contract, not a hardware promise.
DXGI_NOT_FOUND = -2005270526  # HRESULT 0x887a0002
IDENTITY_FIELDS = (
    "name", "vendorId", "deviceId", "subsystemId", "revision", "driverVersion",
    "luid", "dedicatedVideoMemoryBytes", "sharedSystemMemoryLimitBytes",
)


class GpuSelectionError(RuntimeError):
    """No exact hardware-backed, qualification-compatible GPU is available."""


class Guid(ctypes.Structure):
    _fields_ = [("data1", ctypes.c_uint32), ("data2", ctypes.c_uint16),
                ("data3", ctypes.c_uint16), ("data4", ctypes.c_ubyte * 8)]


class Luid(ctypes.Structure):
    _fields_ = [("low", ctypes.c_uint32), ("high", ctypes.c_int32)]


class AdapterDescription(ctypes.Structure):
    _fields_ = [("description", ctypes.c_wchar * 128),
                ("vendor_id", ctypes.c_uint32), ("device_id", ctypes.c_uint32),
                ("subsystem_id", ctypes.c_uint32), ("revision", ctypes.c_uint32),
                ("dedicated_video_memory", ctypes.c_size_t),
                ("dedicated_system_memory", ctypes.c_size_t),
                ("shared_system_memory", ctypes.c_size_t),
                ("luid", Luid), ("flags", ctypes.c_uint32)]


def _method(instance, index, result, *arguments):
    table = ctypes.cast(instance, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    return ctypes.WINFUNCTYPE(result, ctypes.c_void_p, *arguments)(table[index])


def _guid(value: str) -> Guid:
    return Guid.from_buffer_copy(uuid.UUID(value).bytes_le)


def require_native_x64() -> None:
    if sys.platform != "win32" or ctypes.sizeof(ctypes.c_void_p) != 8:
        raise OSError("DirectML requires native Windows x64")
    kernel = ctypes.WinDLL("kernel32.dll", winmode=0x00000800)
    process_machine, native_machine = ctypes.c_uint16(), ctypes.c_uint16()
    query = kernel.IsWow64Process2
    query.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint16), ctypes.POINTER(ctypes.c_uint16)]
    query.restype = ctypes.c_int
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    if not query(kernel.GetCurrentProcess(), ctypes.byref(process_machine), ctypes.byref(native_machine)):
        raise OSError("Native Windows architecture is unavailable")
    if native_machine.value != 0x8664 or process_machine.value != 0:
        raise OSError("DirectML requires native x64; ARM and emulated hosts are unsupported")


def _description_identity(adapter, index: int) -> dict[str, object] | None:
    description = AdapterDescription()
    get_description = _method(adapter, 10, ctypes.c_int32, ctypes.POINTER(AdapterDescription))
    if get_description(adapter, ctypes.byref(description)) < 0:
        raise OSError("DXGI adapter description failed")
    if description.flags & 2 or not description.vendor_id:
        return None  # Software adapters keep their ordinal but are never candidates.
    name = description.description.strip()
    if not name or len(name) > 128 or any(ord(character) < 32 for character in name):
        raise OSError("DXGI adapter name is invalid")
    driver = ctypes.c_int64()
    driver_iid = _guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c")
    check_driver = _method(adapter, 9, ctypes.c_int32, ctypes.POINTER(Guid), ctypes.POINTER(ctypes.c_int64))
    if check_driver(adapter, ctypes.byref(driver_iid), ctypes.byref(driver)) < 0 or driver.value <= 0:
        return None  # No reliable driver identity means no reusable receipt.
    d3d = ctypes.WinDLL("d3d12.dll", winmode=0x00000800)
    create_device = d3d.D3D12CreateDevice
    create_device.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(Guid), ctypes.c_void_p]
    create_device.restype = ctypes.c_int32
    iid = _guid("189819f1-1db6-4b57-be54-1821339b85f7")
    # A null output requests capability validation only (success is S_FALSE).
    if create_device(adapter, 0xb000, ctypes.byref(iid), None) < 0:
        return None
    return {
        "source": "DXGI EnumAdapters1/GetDesc1", "deviceIndex": index,
        "name": name, "vendorId": description.vendor_id,
        "deviceId": description.device_id, "subsystemId": description.subsystem_id,
        "revision": description.revision,
        "driverVersion": ".".join(str((driver.value >> shift) & 0xffff) for shift in (48, 32, 16, 0)),
        "luid": f"{description.luid.high & 0xffffffff:08x}{description.luid.low:08x}",
        "dedicatedVideoMemoryBytes": description.dedicated_video_memory,
        "sharedSystemMemoryLimitBytes": description.shared_system_memory,
    }


def enumerate_adapters() -> list[dict[str, object]]:
    require_native_x64()
    dxgi = ctypes.WinDLL("dxgi.dll", winmode=0x00000800)
    create = dxgi.CreateDXGIFactory1
    create.argtypes = [ctypes.POINTER(Guid), ctypes.POINTER(ctypes.c_void_p)]
    create.restype = ctypes.c_int32
    iid = _guid("770aae78-f26f-4dba-a829-253c83d1b387")
    factory = ctypes.c_void_p()
    if create(ctypes.byref(iid), ctypes.byref(factory)) < 0 or not factory:
        raise OSError("DXGI factory creation failed")
    result: list[dict[str, object]] = []
    try:
        enumerate_adapter = _method(factory, 12, ctypes.c_int32, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p))
        for index in range(MAX_DEVICE_INDEX + 1):
            adapter = ctypes.c_void_p()
            status = enumerate_adapter(factory, index, ctypes.byref(adapter))
            if status == DXGI_NOT_FOUND:
                break
            if status < 0 or not adapter:
                raise OSError("DXGI adapter enumeration failed")
            try:
                identity = _description_identity(adapter, index)
                if identity is not None:
                    result.append(validate_identity(identity))
            finally:
                _method(adapter, 2, ctypes.c_uint32)(adapter)
        return result
    finally:
        _method(factory, 2, ctypes.c_uint32)(factory)


def validate_identity(value: object) -> dict[str, object]:
    fields = {"source", "deviceIndex", *IDENTITY_FIELDS}
    if not isinstance(value, dict) or set(value) != fields or value.get("source") != "DXGI EnumAdapters1/GetDesc1":
        raise GpuSelectionError("GPU identity is incomplete")
    for key in ("deviceIndex", "vendorId", "deviceId", "subsystemId", "revision", "dedicatedVideoMemoryBytes", "sharedSystemMemoryLimitBytes"):
        item = value[key]
        maximum = MAX_DEVICE_INDEX if key == "deviceIndex" else (2**53 - 1 if "Bytes" in key else 0xffffffff)
        if isinstance(item, bool) or not isinstance(item, int) or not 0 <= item <= maximum:
            raise GpuSelectionError("GPU identity contains an invalid integer")
    if value["vendorId"] == 0:
        raise GpuSelectionError("GPU identity is not hardware")
    name = value["name"]
    if not isinstance(name, str) or not name or len(name) > 128 or any(ord(character) < 32 for character in name):
        raise GpuSelectionError("GPU name is invalid")
    if not isinstance(value["luid"], str) or re.fullmatch(r"[0-9a-f]{16}", value["luid"]) is None:
        raise GpuSelectionError("GPU LUID is invalid")
    if not isinstance(value["driverVersion"], str) or re.fullmatch(r"\d{1,5}(\.\d{1,5}){3}", value["driverVersion"]) is None:
        raise GpuSelectionError("GPU driver version is invalid")
    return dict(value)


def physical_gpu_id(identity: dict[str, object]) -> str:
    verified = validate_identity(identity)
    return f"dxgi-{verified['luid']}"


def receipt_identity(identity: dict[str, object]) -> dict[str, object]:
    verified = validate_identity(identity)
    return {key: verified[key] for key in IDENTITY_FIELDS}


def resolve_adapter(preference: dict[str, object], adapters: Iterable[dict[str, object]] | None = None) -> dict[str, object]:
    expected = receipt_identity(preference)
    matches = [item for item in ranked_candidates(adapters) if receipt_identity(item) == expected]
    if len(matches) != 1:
        raise GpuSelectionError("Qualified GPU or driver changed; qualification is required")
    return matches[0]


def ranked_candidates(adapters: Iterable[dict[str, object]] | None = None, preference: dict[str, object] | None = None) -> list[dict[str, object]]:
    verified = [validate_identity(item) for item in (enumerate_adapters() if adapters is None else adapters)]
    if len({item["luid"] for item in verified}) != len(verified) or len({item["deviceIndex"] for item in verified}) != len(verified):
        raise GpuSelectionError("GPU enumeration has duplicate identities or ordinals")
    preferred = receipt_identity(preference) if preference is not None else None
    # Preference is tried only when its complete device/driver identity matches.
    # Then discrete memory, available shared memory, stable identity and ordinal.
    # These are candidate priorities, never a claim of speed or qualification.
    return sorted(verified, key=lambda item: (
        0 if preferred is not None and receipt_identity(item) == preferred else 1,
        -int(item["dedicatedVideoMemoryBytes"]), -int(item["sharedSystemMemoryLimitBytes"]),
        str(item["luid"]), int(item["deviceIndex"]),
    ))


def adapter_identity(index: int = 0) -> dict[str, object]:
    if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index <= MAX_DEVICE_INDEX:
        raise GpuSelectionError("DirectML adapter index is invalid")
    matches = [item for item in enumerate_adapters() if item["deviceIndex"] == index]
    if len(matches) != 1:
        raise GpuSelectionError("Selected DirectML adapter is not supported hardware")
    return matches[0]


def qualify_candidates(qualify: Callable[[dict[str, object]], dict[str, object]], *, adapters: Iterable[dict[str, object]] | None = None, preference: dict[str, object] | None = None) -> dict[str, object]:
    """Try each bounded hardware candidate once, never substitute CPU inference."""
    failures: list[str] = []
    candidates = ranked_candidates(adapters, preference)
    for candidate in candidates:
        try:
            report = qualify(candidate)
            dispatch = report.get("providerDispatch", {})
            if (report.get("status") != "PASS" or report.get("gpuIdentity") != candidate
                    or not isinstance(dispatch, dict) or dispatch.get("proven") is not True
                    or dispatch.get("cpuNodeEvents") != 0 or int(dispatch.get("acceleratedNodeEvents", 0)) < 1):
                raise GpuSelectionError("Candidate did not prove GPU inference")
            return report
        except (OSError, RuntimeError, ValueError, TypeError) as error:
            failures.append(f"{physical_gpu_id(candidate)}: {type(error).__name__}")
    raise GpuSelectionError("No GPU passed qualification" + (" (" + "; ".join(failures) + ")" if failures else ""))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=int)
    parser.add_argument("--list", action="store_true")
    arguments = parser.parse_args()
    if arguments.index is not None and arguments.list:
        parser.error("--index and --list are mutually exclusive")
    result = ranked_candidates() if arguments.list else adapter_identity(arguments.index or 0)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
